import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CredentialDetachConflict, detachCredential, type DetachCredentialInput } from '../../src/db/credential-detach-db.js';

const prefix = `user_detach_integrity_${randomUUID().slice(0, 8)}_`;
const users = ['personal', 'corporate', 'sibling', 'actor'].map((suffix) => `${prefix}${suffix}`);
const [personal, corporate, sibling, actor] = users;
const orgs = [`${prefix}personal_org`, `${prefix}corporate_org`];
let pool: Pool;
let groupId: string;

// Full rows include identifiers, role/provisioning/grant provenance and timestamps.
// WorkOS API keys have no local table; the detach helper has no provider dependency.
async function authoritySnapshot() {
  const queries = [
    ['users', 'workos_user_id = ANY($1)', users],
    ['organization_memberships', 'workos_user_id = ANY($1)', users],
    ['organization_credential_grants', 'workos_user_id = ANY($1)', users],
    ['working_group_memberships', 'workos_user_id = ANY($1)', users],
    ['working_group_leaders', 'user_id = ANY($1)', users],
    ['organizations', 'workos_organization_id = ANY($1)', orgs],
    ['subscription_line_items', 'workos_organization_id = ANY($1)', orgs],
  ] as const;
  return Object.fromEntries(await Promise.all(queries.map(async ([table, where, ids]) => [table,
    (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`, [ids])).rows,
  ])));
}

async function bindingSnapshot() {
  return {
    bindings: (await pool.query('SELECT * FROM identity_workos_users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [users])).rows,
    epochs: (await pool.query('SELECT * FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [users])).rows,
    audits: (await pool.query(`SELECT * FROM registry_audit_log WHERE resource_id = ANY($1)
      OR workos_user_id = ANY($1) OR details->>'provider_user_id' = ANY($1) ORDER BY id`, [users])).rows,
    bindOperations: (await pool.query(`SELECT * FROM admin_credential_bind_operations
      WHERE host_user_id = ANY($1) OR provider_user_id = ANY($1) ORDER BY id`, [users])).rows,
    identities: (await pool.query('SELECT * FROM identities ORDER BY id')).rows,
  };
}

async function fixture(direction: 'personal' | 'corporate' = 'personal'): Promise<DetachCredentialInput> {
  await pool.query(`INSERT INTO organizations (workos_organization_id, name, is_personal, subscription_status,
      stripe_subscription_id, subscription_metadata)
    VALUES ($1, 'Personal workspace', TRUE, NULL, NULL, NULL),
      ($2, 'Pinnacle Agency', FALSE, 'active', $3, '{"source":"original-subscription"}')`,
  [orgs[0], orgs[1], `${prefix}subscription`]);
  for (const [index, user] of users.entries()) {
    await pool.query(`INSERT INTO users (workos_user_id, email, primary_organization_id)
      VALUES ($1, $2, $3)`, [user, `${user}@${index === 0 ? 'personal.example' : 'pinnacle.example'}`, orgs[index === 0 ? 0 : 1]]);
  }
  const hostUserId = direction === 'personal' ? personal : corporate;
  const credentialId = direction === 'personal' ? corporate : personal;
  const initialBindings = (await pool.query<{ workos_user_id: string; identity_id: string }>(
    'SELECT workos_user_id, identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [users],
  )).rows;
  const expectedIdentityId = initialBindings.find((row) => row.workos_user_id === hostUserId)!.identity_id;
  const actorIdentityId = initialBindings.find((row) => row.workos_user_id === actor)!.identity_id;
  await pool.query(`UPDATE identity_workos_users SET identity_id = $1, is_primary = FALSE
    WHERE workos_user_id = ANY($2)`, [expectedIdentityId, [credentialId, sibling]]);
  await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [initialBindings
    .filter((row) => [credentialId, sibling].includes(row.workos_user_id)).map((row) => row.identity_id)]);
  await pool.query(`INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ($1, 7), ($2, 11)`, [credentialId, actor]);

  // The unattributed membership is deliberately left as found after a legacy merge.
  await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, provisioning_source)
    VALUES ($1, $3, $5, 'personal@personal.example', 'owner', 'invitation'),
      ($2, $4, $6, 'corporate@pinnacle.example', 'admin', 'sso'),
      ($1, $4, $7, 'personal@personal.example', 'member', NULL)`,
  [personal, corporate, orgs[0], orgs[1], `${prefix}membership1`, `${prefix}membership2`, `${prefix}legacy`]);
  await pool.query(`INSERT INTO organization_credential_grants
      (workos_organization_id, workos_user_id, role, granted_by_workos_user_id, reason)
    VALUES ($1, $3, 'admin', $5, 'Original grant'), ($2, $4, 'member', $5, 'Independent grant')`,
  [orgs[1], orgs[0], personal, corporate, actor]);
  groupId = (await pool.query<{ id: string }>(
    `INSERT INTO working_groups (name, slug) VALUES ('Detach integrity fixture', $1) RETURNING id`, [prefix],
  )).rows[0].id;
  const adminGroup = (await pool.query<{ id: string }>(`SELECT id FROM working_groups WHERE slug = 'aao-admin'`)).rows[0];
  expect(adminGroup).toBeDefined();
  await pool.query(`INSERT INTO working_group_memberships (working_group_id, workos_user_id, added_by_user_id)
    VALUES ($1, $3, $5), ($2, $4, $5)`, [groupId, adminGroup.id, personal, corporate, actor]);
  await pool.query('INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)', [groupId, corporate]);
  await pool.query(`INSERT INTO subscription_line_items
    (workos_organization_id, stripe_subscription_id, stripe_subscription_item_id, price_id, quantity, metadata)
    VALUES ($1, $2, $3, 'price_original', 3, '{"source":"billing"}')`,
  [orgs[1], `${prefix}subscription`, `${prefix}item`]);
  return { hostUserId, credentialId, expectedIdentityId, expectedAuthorizationEpoch: '7',
    actorUserId: actor, actorCredentialId: actor, actorIdentityId };
}

async function fixtureWithSecondaryActor(): Promise<DetachCredentialInput> {
  const input = await fixture();
  await pool.query('UPDATE identity_workos_users SET identity_id = $1 WHERE workos_user_id = $2',
    [input.actorIdentityId, sibling]);
  return { ...input, actorCredentialId: sibling };
}

const lifecycleRoles = ['target', 'host', 'actor', 'canonical'] as const;
function graphCredential(input: DetachCredentialInput, role: typeof lifecycleRoles[number]): string {
  return { target: input.credentialId, host: input.hostUserId,
    actor: input.actorCredentialId, canonical: input.actorUserId }[role];
}

async function insertBindOperation(input: DetachCredentialInput, providerUserId: string, status: string) {
  return (await pool.query<{ id: string }>(`INSERT INTO admin_credential_bind_operations
    (email_hash, host_user_id, host_identity_id, actor_user_id, actor_identity_id, provider_user_id, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
  [randomUUID(), input.hostUserId, input.expectedIdentityId, input.actorCredentialId,
    input.actorIdentityId, providerUserId, status])).rows[0].id;
}

async function expectConflictWithoutMutation(input: DetachCredentialInput) {
  const before = await bindingSnapshot();
  const authority = await authoritySnapshot();
  await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
  expect(await bindingSnapshot()).toEqual(before);
  expect(await authoritySnapshot()).toEqual(authority);
}

async function installFault(
  table: 'registry_audit_log' | 'authorization_epochs', timing: 'BEFORE' | 'AFTER', body: string, deferred = false,
) {
  await pool.query(`CREATE FUNCTION detach_integrity_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
  const column = table === 'registry_audit_log' ? 'resource_id' : 'workos_user_id';
  await pool.query(`CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER detach_integrity_fault ${timing} INSERT OR UPDATE ON ${table}
    ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''}
    FOR EACH ROW WHEN (NEW.${column} LIKE '${prefix}%') EXECUTE FUNCTION detach_integrity_fault()`);
}

describe('binding-only credential detach (real PostgreSQL)', () => {
  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test' });
    await runMigrations();
  }, 60000);

  afterEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS detach_integrity_fault ON registry_audit_log');
    await pool.query('DROP TRIGGER IF EXISTS detach_integrity_fault ON authorization_epochs');
    await pool.query('DROP FUNCTION IF EXISTS detach_integrity_fault()');
    const identities = (await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [users],
    )).rows.map((row) => row.identity_id);
    await pool.query(`DELETE FROM registry_audit_log WHERE resource_id = ANY($1)
      OR workos_user_id = ANY($1) OR details->>'provider_user_id' = ANY($1)`, [users]);
    await pool.query(`DELETE FROM admin_credential_bind_operations
      WHERE host_user_id = ANY($1) OR provider_user_id = ANY($1)`, [users]);
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [users]);
    await pool.query('DELETE FROM working_groups WHERE slug = $1', [prefix]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [users]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [users]);
    await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [identities]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [orgs]);
  });
  afterAll(() => closeDatabase());

  it.each(['personal', 'corporate'] as const)('detaches from a %s host without changing any authority provenance', async (direction) => {
    const input = await fixture(direction);
    const authority = await authoritySnapshot();
    const before = await bindingSnapshot();
    const result = await detachCredential(input);
    expect(await authoritySnapshot()).toEqual(authority);
    const after = await bindingSnapshot();
    expect(after.identities).toHaveLength(before.identities.length + 1);
    expect(after.bindings.filter((row) => row.workos_user_id !== input.credentialId))
      .toEqual(before.bindings.filter((row) => row.workos_user_id !== input.credentialId));
    expect(after.bindings.find((row) => row.workos_user_id === input.credentialId))
      .toMatchObject({ identity_id: result.newIdentityId, is_primary: true });
    expect(result.affectedCredentialIds).toEqual([personal, corporate, sibling].sort());
    expect(Object.fromEntries(after.epochs.map((row) => [row.workos_user_id, row.epoch])))
      .toEqual({ [input.hostUserId]: '1', [input.credentialId]: '8', [sibling]: '1', [actor]: '11' });
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: 'unbind_credential', workos_user_id: actor, resource_id: input.credentialId,
      details: { operation_id: after.audits[0].id, acting_workos_user_id: actor, acting_identity_id: input.actorIdentityId,
        affected_workos_user_id: input.credentialId, detached_from_identity_id: input.expectedIdentityId,
        new_identity_id: result.newIdentityId, expected_authorization_epoch: '7' } });
    expect(after.epochs.find((row) => row.workos_user_id === actor)).toEqual(before.epochs.find((row) => row.workos_user_id === actor));
  });

  it('accepts a sibling URL host and advances all old-identity epochs', async () => {
    const input = await fixture();
    const authority = await authoritySnapshot();
    const result = await detachCredential({ ...input, hostUserId: sibling });
    expect(result.affectedCredentialIds).toEqual([personal, corporate, sibling].sort());
    expect(await authoritySnapshot()).toEqual(authority);
    expect((await bindingSnapshot()).epochs).toEqual(expect.arrayContaining([
      expect.objectContaining({ workos_user_id: personal, epoch: '1' }),
      expect.objectContaining({ workos_user_id: sibling, epoch: '1' }),
      expect.objectContaining({ workos_user_id: corporate, epoch: '8' }),
    ]));
  });

  it('records the authenticated secondary actor credential separately from its canonical user', async () => {
    const input = await fixture();
    await detachCredential({ ...input, actorCredentialId: sibling, actorUserId: personal, actorIdentityId: input.expectedIdentityId });
    expect((await bindingSnapshot()).audits[0]).toMatchObject({ workos_user_id: personal,
      details: { acting_workos_user_id: sibling, acting_identity_id: input.expectedIdentityId } });
  });

  it('preserves a valid separate actor identity and attributes its authenticated secondary credential', async () => {
    const input = await fixtureWithSecondaryActor();
    const authority = await authoritySnapshot();
    const before = await bindingSnapshot();
    await detachCredential(input);
    const after = await bindingSnapshot();
    expect(await authoritySnapshot()).toEqual(authority);
    expect(after.bindings.filter((row) => [actor, sibling].includes(row.workos_user_id)))
      .toEqual(before.bindings.filter((row) => [actor, sibling].includes(row.workos_user_id)));
    expect(after.epochs.filter((row) => [actor, sibling].includes(row.workos_user_id)))
      .toEqual(before.epochs.filter((row) => [actor, sibling].includes(row.workos_user_id)));
    expect(after.bindOperations).toEqual(before.bindOperations);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ workos_user_id: actor, resource_id: input.credentialId,
      details: { acting_workos_user_id: sibling, acting_identity_id: input.actorIdentityId } });
  });

  const terminalActions = ['identity_credential_deleted', 'identity_primary_deletion_quarantined',
    'identity_credential_admin_compensation_deleted', 'identity_credential_admin_compensation_quarantined'] as const;
  it.each(terminalActions.flatMap((action) => lifecycleRoles.map((role) => ({ action, role }))))(
    'rejects $action on the $role credential without changing authority or lifecycle evidence', async ({ action, role }) => {
      const input = await fixtureWithSecondaryActor();
      const userId = graphCredential(input, role);
      await pool.query(`INSERT INTO registry_audit_log
        (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
        VALUES ('system', $1::text, $2, 'identity_credential', $1::text, '{}'::jsonb)`, [userId, action]);
      await expectConflictWithoutMutation(input);
    },
  );

  it.each(lifecycleRoles)('rejects a reconciliation journal provider_user_id matching the %s credential', async (role) => {
    const input = await fixtureWithSecondaryActor();
    await insertBindOperation(input, graphCredential(input, role), 'reconciliation_required');
    await expectConflictWithoutMutation(input);
  });

  it.each(['creating', 'provider_created', 'compensating', 'compensated', 'provider_rejected'] as const)(
    'rejects a %s journal for the affected credential without rewriting its status', async (status) => {
      const input = await fixture();
      await insertBindOperation(input, input.credentialId, status);
      await expectConflictWithoutMutation(input);
    },
  );

  const bindAuditStatuses = ['reconciliation_required', 'compensating', 'compensated'] as const;
  it.each(bindAuditStatuses.flatMap((status) => lifecycleRoles.map((role) => ({ status, role }))))(
    'rejects immutable bind $status evidence identifying the $role credential', async ({ status, role }) => {
      const input = await fixtureWithSecondaryActor();
      const providerUserId = graphCredential(input, role);
      // An older operator outside this graph created the record. Only the immutable
      // provider_user_id payload identifies the affected credential, not the actor column.
      const historicalOperator = `${prefix}historical_operator`;
      expect(users).not.toContain(historicalOperator);
      await pool.query(`INSERT INTO registry_audit_log
        (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
        VALUES ('system', $1, 'admin_credential_bind', 'admin_credential_bind_operation', $2, $3)`,
      [historicalOperator, randomUUID(), { status, provider_user_id: providerUserId }]);
      expect((await bindingSnapshot()).bindOperations).toEqual([]);
      await expectConflictWithoutMutation(input);
    },
  );

  it('preserves bind evidence about another provider credential when its audit actor belongs to this graph', async () => {
    const input = await fixtureWithSecondaryActor();
    const providerUserId = `${prefix}outside_graph`;
    expect(users).not.toContain(providerUserId);
    await pool.query(`INSERT INTO registry_audit_log
      (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
      VALUES ('system', $1, 'admin_credential_bind', 'admin_credential_bind_operation', $2, $3)`,
    [input.credentialId, randomUUID(), { status: 'reconciliation_required', provider_user_id: providerUserId }]);
    const before = await bindingSnapshot();
    const authority = await authoritySnapshot();
    await detachCredential(input);
    const after = await bindingSnapshot();
    const detachAudits = after.audits.filter((row) => row.action === 'unbind_credential');
    expect(detachAudits).toHaveLength(1);
    expect(after.audits.filter((row) => row.id !== detachAudits[0].id)).toEqual(before.audits);
    expect(after.bindOperations).toEqual(before.bindOperations);
    expect(await authoritySnapshot()).toEqual(authority);
  });

  it.each(['zero-primary', 'canonical-user-is-secondary'] as const)(
    'rejects an actor identity with %s without changing its graph', async (fault) => {
      const input = await fixtureWithSecondaryActor();
      if (fault === 'zero-primary') {
        await pool.query('UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1', [actor]);
      } else {
        input.actorUserId = sibling;
      }
      await expectConflictWithoutMutation(input);
    },
  );

  it('rejects replay without another audit or epoch increment', async () => {
    const input = await fixture();
    await detachCredential(input);
    const before = await bindingSnapshot();
    await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
    expect(await bindingSnapshot()).toEqual(before);
  });

  it('rejects an old request even when the credential is rebound to the same identity', async () => {
    const input = await fixture();
    const detached = await detachCredential(input);
    await pool.query('UPDATE identity_workos_users SET identity_id = $1, is_primary = FALSE WHERE workos_user_id = $2',
      [input.expectedIdentityId, input.credentialId]);
    await pool.query('DELETE FROM identities WHERE id = $1', [detached.newIdentityId]);
    const before = await bindingSnapshot();
    await expect(detachCredential(input)).rejects.toThrow('authorization changed');
    expect(await bindingSnapshot()).toEqual(before);
  });

  it.each(['identity', 'epoch', 'actor', 'primary', 'same-user', 'missing-primary'])(
    'rejects stale or invalid %s state without mutation', async (fault) => {
      const input = await fixture();
      if (fault === 'identity') input.expectedIdentityId = input.actorIdentityId;
      if (fault === 'epoch') input.expectedAuthorizationEpoch = '6';
      if (fault === 'actor') input.actorCredentialId = sibling;
      if (fault === 'primary') { input.credentialId = personal; input.hostUserId = sibling; }
      if (fault === 'same-user') input.hostUserId = input.credentialId;
      if (fault === 'missing-primary') await pool.query('UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1', [personal]);
      const before = await bindingSnapshot();
      const authority = await authoritySnapshot();
      await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
      expect(await bindingSnapshot()).toEqual(before);
      expect(await authoritySnapshot()).toEqual(authority);
    },
  );

  const auditFaults = [
    ['BEFORE RETURN NULL suppresses INSERT (rowCount 0)', 'BEFORE', 'RETURN NULL;'],
    ['thrown audit error', 'BEFORE', "RAISE EXCEPTION 'injected audit failure';"],
    ['AFTER DELETE removes the returned row', 'AFTER', 'DELETE FROM registry_audit_log WHERE id = NEW.id; RETURN NEW;'],
    ['AFTER duplicate creates two durable records', 'AFTER', `IF pg_trigger_depth() = 1 THEN
      INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
      VALUES (NEW.workos_organization_id, NEW.workos_user_id, NEW.action, NEW.resource_type, NEW.resource_id, NEW.details);
      END IF; RETURN NEW;`],
    ['AFTER duplicate alters its payload but keeps operation_id', 'AFTER', `IF pg_trigger_depth() = 1 THEN
      INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
      VALUES (NEW.workos_organization_id, NEW.workos_user_id, NEW.action, NEW.resource_type, NEW.resource_id,
        NEW.details || '{"duplicate":true}'::jsonb); END IF; RETURN NEW;`],
    ['BEFORE changes the returned audit id', 'BEFORE', 'NEW.id := gen_random_uuid(); RETURN NEW;'],
    ['BEFORE removes actor attribution', 'BEFORE', "NEW.details := NEW.details - 'acting_workos_user_id'; RETURN NEW;"],
  ] as const;
  it.each(auditFaults)('rolls back binding, epochs and audit when %s', async (_name, timing, body) => {
    const input = await fixture();
    const before = await bindingSnapshot();
    const authority = await authoritySnapshot();
    await installFault('registry_audit_log', timing, body);
    await expect(detachCredential(input)).rejects.toThrow();
    expect(await bindingSnapshot()).toEqual(before);
    expect(await authoritySnapshot()).toEqual(authority);
  });

  it.each([
    ['BEFORE', 'RETURN NULL;'],
    ['BEFORE', "RAISE EXCEPTION 'injected epoch failure';"],
    ['BEFORE', "IF TG_OP = 'UPDATE' THEN RETURN OLD; END IF; RETURN NEW;"],
    ['AFTER', `IF TG_OP = 'UPDATE' AND pg_trigger_depth() = 1 THEN
      UPDATE authorization_epochs SET epoch = OLD.epoch WHERE workos_user_id = NEW.workos_user_id;
      END IF; RETURN NEW;`],
  ] as const)(
    'rolls back on authorization epoch suppression or failure: %s %s', async (timing, body) => {
      const input = await fixture();
      const before = await bindingSnapshot();
      const authority = await authoritySnapshot();
      await installFault('authorization_epochs', timing, body);
      await expect(detachCredential(input)).rejects.toThrow();
      expect(await bindingSnapshot()).toEqual(before);
      expect(await authoritySnapshot()).toEqual(authority);
    },
  );

  it('rolls back even after writing the audit if advisory unlock fails', async () => {
    const input = await fixture();
    const before = await bindingSnapshot();
    const authority = await authoritySnapshot();
    await installFault('registry_audit_log', 'AFTER', 'PERFORM pg_advisory_unlock_all(); RETURN NEW;');
    await expect(detachCredential(input)).rejects.toThrow('advisory unlock failed');
    expect(await bindingSnapshot()).toEqual(before);
    expect(await authoritySnapshot()).toEqual(authority);
  });

  it.each(['registry_audit_log', 'authorization_epochs'] as const)(
    'flushes deferred %s triggers and rejects changed durable state before commit', async (table) => {
      const input = await fixture();
      const before = await bindingSnapshot();
      const authority = await authoritySnapshot();
      const body = table === 'registry_audit_log'
        ? 'DELETE FROM registry_audit_log WHERE id = NEW.id; RETURN NEW;'
        : `IF NEW.epoch <> 7 THEN
          UPDATE authorization_epochs SET epoch = 7 WHERE workos_user_id = NEW.workos_user_id;
          END IF; RETURN NEW;`;
      await installFault(table, 'AFTER', body, true);
      await expect(detachCredential(input)).rejects.toThrow();
      expect(await bindingSnapshot()).toEqual(before);
      expect(await authoritySnapshot()).toEqual(authority);
    },
  );

  it('rolls back detach and its audit when a deferred trigger adds a terminal lifecycle marker', async () => {
    const input = await fixture();
    await installFault('registry_audit_log', 'AFTER', `IF NEW.action = 'unbind_credential' THEN
      INSERT INTO registry_audit_log
        (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
      VALUES ('system', NEW.resource_id, 'identity_credential_admin_compensation_quarantined',
        'identity_credential', NEW.resource_id, '{}'::jsonb);
      END IF; RETURN NEW;`, true);
    await expectConflictWithoutMutation(input);
  });

  it('allows exactly one concurrent detach, with one durable audit and one epoch bump', async () => {
    const input = await fixture();
    const authority = await authoritySnapshot();
    const blocker = await pool.connect();
    const barrier = 6827001;
    await blocker.query('SELECT pg_advisory_lock($1)', [barrier]);
    await installFault('registry_audit_log', 'BEFORE', `PERFORM pg_advisory_xact_lock(${barrier}); RETURN NEW;`);
    const first = detachCredential(input);
    try {
      // Wait for the first transaction to reach the audit INSERT while still
      // holding its binding locks, rather than relying on a scheduling sleep.
      await expect.poll(async () => (await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event = 'advisory' AND query LIKE 'INSERT INTO registry_audit_log%'`,
      )).rowCount, { timeout: 5000 }).toBe(1);
      await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
    } finally {
      expect((await blocker.query('SELECT pg_advisory_unlock($1) AS unlocked', [barrier])).rows[0].unlocked).toBe(true);
      blocker.release();
      await first;
    }
    expect(await authoritySnapshot()).toEqual(authority);
    const after = await bindingSnapshot();
    expect(after.audits).toHaveLength(1);
    expect(after.epochs.find((row) => row.workos_user_id === corporate)?.epoch).toBe('8');
  });

  it.each(['identity', 'epoch'])('rejects a concurrent %s writer without waiting or changing state', async (kind) => {
    const input = await fixture();
    const before = await bindingSnapshot();
    const writer = await pool.connect();
    await writer.query('BEGIN');
    try {
      if (kind === 'identity') await writer.query('SELECT id FROM identities WHERE id = $1 FOR UPDATE', [input.expectedIdentityId]);
      else await writer.query('SELECT workos_user_id FROM authorization_epochs WHERE workos_user_id = $1 FOR UPDATE', [corporate]);
      await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
      expect(await bindingSnapshot()).toEqual(before);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });
});
