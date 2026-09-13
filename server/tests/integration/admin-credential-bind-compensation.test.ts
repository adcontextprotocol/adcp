/**
 * Admin create-and-bind uses real PostgreSQL transactions and a mocked WorkOS
 * boundary. Transport faults deliberately leave the provider outcome unknown;
 * a stale provider read cannot authorize replay or destructive compensation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const provider = vi.hoisted(() => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getUser: vi.fn(),
  listUsers: vi.fn(),
  createOrganizationMembership: vi.fn(),
  updateOrganizationMembership: vi.fn(),
  deleteOrganizationMembership: vi.fn(),
}));
const logs = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getAdminCredentialMutationWorkos: () => ({ userManagement: provider }),
}));
vi.mock('../../src/logger.js', () => ({ createLogger: () => logs }));
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));

import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getAuthorizationFingerprint } from '../../src/db/authorization-epoch-db.js';
import { createAndBindAdminCredential } from '../../src/services/admin-credential-bind.js';

const PREFIX = 'user_admin_bind_compensation_';
const HOST = `${PREFIX}sam`;
const HOST_SIBLING = `${PREFIX}sam_existing_credential`;
const OTHER_HOST = `${PREFIX}priya`;
const ACTOR_PRIMARY = `${PREFIX}jordan`;
const ACTOR_CREDENTIAL = `${PREFIX}jordan_credential`;
const CREATED = `${PREFIX}sam_new_credential`;
const ORG = 'org_admin_bind_compensation_pinnacle';
const EMAIL = 'sam.new@admin-bind.example';
const SECRET = 'provider-body-with-password-and-access-token-must-not-be-retained';

interface Operation {
  id: string;
  email_hash: string;
  host_user_id: string;
  host_identity_id: string;
  actor_user_id: string;
  actor_identity_id: string;
  provider_user_id: string | null;
  status: string;
  failure_code: string | null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('admin credential create-and-bind compensation', () => {
  let pool: Pool;
  let actorIdentityId: string;
  let hostIdentityId: string;
  const fixtureIdentities = new Set<string>();

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    if (pool) await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    for (const mock of Object.values(provider)) mock.mockReset();
    provider.createUser.mockResolvedValue(createdUser());
    provider.deleteUser.mockResolvedValue(undefined);
    // These intentionally stale responses would conceal delayed provider
    // completion if the implementation used immediate reads as adjudication.
    provider.getUser.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    provider.listUsers.mockResolvedValue({ data: [] });

    await insertUser(HOST, 'sam@admin-bind.example', 'Sam', 'Adeyemi');
    await insertUser(HOST_SIBLING, 'sam.existing@admin-bind.example', 'Sam', 'Adeyemi');
    await insertUser(OTHER_HOST, 'priya@admin-bind.example', 'Priya', 'Nair');
    await insertUser(ACTOR_PRIMARY, 'jordan@admin-bind.example', 'Jordan', 'Ochoa');
    await insertUser(ACTOR_CREDENTIAL, 'jordan.credential@admin-bind.example', 'Jordan', 'Ochoa');
    actorIdentityId = await identityOf(ACTOR_PRIMARY);
    hostIdentityId = await identityOf(HOST);
    await pool.query(
      `UPDATE identity_workos_users SET identity_id = $1, is_primary = false WHERE workos_user_id = $2`,
      [hostIdentityId, HOST_SIBLING],
    );
    await pool.query(
      `UPDATE identity_workos_users SET identity_id = $1, is_primary = false WHERE workos_user_id = $2`,
      [actorIdentityId, ACTOR_CREDENTIAL],
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name) VALUES ($1, 'Pinnacle Agency')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO organization_memberships
        (workos_user_id, workos_organization_id, email, role)
       VALUES ($1, $2, 'sam@admin-bind.example', 'admin')`,
      [HOST, ORG],
    );
    await pool.query('UPDATE users SET primary_organization_id = $1 WHERE workos_user_id = $2', [ORG, HOST]);
  });

  function createdUser() {
    return {
      id: CREATED, email: EMAIL, firstName: 'Sam', lastName: 'Adeyemi',
      emailVerified: false, createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
  }

  function input(overrides: Partial<Parameters<typeof createAndBindAdminCredential>[0]> = {}) {
    return { hostUserId: HOST, email: EMAIL, actorUserId: ACTOR_CREDENTIAL, actorIdentityId, ...overrides };
  }

  async function insertUser(id: string, email: string, firstName: string, lastName: string) {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
        workos_created_at, workos_updated_at) VALUES ($1, $2, $3, $4, true, NOW(), NOW())`,
      [id, email, firstName, lastName],
    );
    fixtureIdentities.add(await identityOf(id));
  }

  async function identityOf(userId: string) {
    const result = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1', [userId],
    );
    return result.rows[0].identity_id;
  }

  async function cleanup() {
    await pool.query('DROP TRIGGER IF EXISTS admin_bind_test_fail_insert ON users');
    await pool.query('DROP FUNCTION IF EXISTS admin_bind_test_fail_insert()');
    await pool.query('DROP TRIGGER IF EXISTS admin_bind_test_fail_audit ON registry_audit_log');
    await pool.query('DROP TRIGGER IF EXISTS admin_bind_test_fail_intent ON admin_credential_bind_operations');
    await pool.query('DROP TRIGGER IF EXISTS admin_bind_test_fail_reconciliation ON admin_credential_bind_operations');
    await pool.query('DROP FUNCTION IF EXISTS admin_bind_test_fail_journal()');
    const identities = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE starts_with(workos_user_id, $1)', [PREFIX],
    );
    for (const row of identities.rows) fixtureIdentities.add(row.identity_id);
    await pool.query(
      `DELETE FROM registry_audit_log WHERE resource_id IN
        (SELECT id::text FROM admin_credential_bind_operations WHERE starts_with(host_user_id, $1))`,
      [PREFIX],
    );
    await pool.query('DELETE FROM admin_credential_bind_operations WHERE starts_with(host_user_id, $1)', [PREFIX]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [ORG]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG]);
    await pool.query('DELETE FROM users WHERE starts_with(workos_user_id, $1)', [PREFIX]);
    if (fixtureIdentities.size) {
      await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [[...fixtureIdentities]]);
      fixtureIdentities.clear();
    }
  }

  async function operations() {
    return (await pool.query<Operation>(
      `SELECT * FROM admin_credential_bind_operations WHERE starts_with(host_user_id, $1)
       ORDER BY created_at, id`, [PREFIX],
    )).rows;
  }

  async function expectNoLocalCredential() {
    const rows = await pool.query('SELECT workos_user_id FROM users WHERE workos_user_id = $1', [CREATED]);
    expect(rows.rows).toEqual([]);
    // Confirmed compensation now records a terminal marker in the fingerprint.
    // It must still leave no binding epochs or altered host authority.
    expect((await pool.query('SELECT 1 FROM authorization_epochs WHERE workos_user_id = ANY($1)',
      [[HOST, HOST_SIBLING, CREATED]])).rows).toEqual([]);
    expect(await identityOf(HOST)).toBe(hostIdentityId);
  }

  async function failLocalInsert() {
    await pool.query(`CREATE FUNCTION admin_bind_test_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected local credential write failure';
      END;
    $$`);
    await pool.query(`CREATE TRIGGER admin_bind_test_fail_insert BEFORE INSERT ON users
      FOR EACH ROW WHEN (NEW.workos_user_id = '${CREATED}')
      EXECUTE FUNCTION admin_bind_test_fail_insert()`);
  }

  function assertNoProviderReadsOrMembershipWrites() {
    expect(provider.getUser).not.toHaveBeenCalled();
    expect(provider.listUsers).not.toHaveBeenCalled();
    expect(provider.createOrganizationMembership).not.toHaveBeenCalled();
    expect(provider.updateOrganizationMembership).not.toHaveBeenCalled();
    expect(provider.deleteOrganizationMembership).not.toHaveBeenCalled();
  }

  /** Preserve real transactions; change only a specific transport response. */
  function faultPool(mode: 'commit_reply_lost' | 'rollback_reply_lost' | 'lock_false' | 'unlock_false' | 'lock_reply_lost' | 'lock_reply_malformed') {
    let injected = false;
    const releases: Array<boolean | Error | undefined> = [];
    const proxy = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect') return async () => {
          const client = await target.connect();
          const query = client.query.bind(client);
          const release = client.release.bind(client);
          let localWrite = false;
          client.query = (async (text: string, params?: unknown[]) => {
            if (text.includes('INSERT INTO users')) localWrite = true;
            if (!injected && mode === 'lock_false' && text.includes('pg_try_advisory_lock')) {
              injected = true;
              return { rows: [{ locked: false, acquired: false, pg_try_advisory_lock: false }], rowCount: 1 };
            }
            const result = await query(text, params);
            if (!injected && text.includes('pg_try_advisory_lock') && mode.startsWith('lock_reply_')) {
              injected = true;
              if (mode === 'lock_reply_lost') throw Object.assign(new Error('lock transport reply lost'), { code: 'ECONNRESET' });
              return { ...result, rows: [] };
            }
            if (!injected && mode === 'unlock_false' && text.includes('pg_advisory_unlock')) {
              injected = true;
              return { ...result, rows: [{ unlocked: false, pg_advisory_unlock: false }] };
            }
            if (!injected && mode === 'commit_reply_lost' && localWrite && text.trim() === 'COMMIT') {
              injected = true;
              throw Object.assign(new Error('commit transport reply lost'), { code: 'ECONNRESET' });
            }
            if (!injected && mode === 'rollback_reply_lost' && localWrite && text.trim() === 'ROLLBACK') {
              injected = true;
              throw Object.assign(new Error('rollback transport reply lost'), { code: 'ECONNRESET' });
            }
            return result;
          }) as PoolClient['query'];
          client.release = (error?: boolean | Error) => {
            releases.push(error);
            client.query = query;
            client.release = release;
            release(error);
          };
          return client;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { pool: proxy, releases, wasInjected: () => injected };
  }

  it('binds only the created credential, revokes all host sessions, and records the exact authenticated actor', async () => {
    const result = await createAndBindAdminCredential(input());

    expect(result.status).toBe(201);
    const journal = await operations();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      status: 'committed', host_user_id: HOST, host_identity_id: hostIdentityId,
      actor_user_id: ACTOR_CREDENTIAL, actor_identity_id: actorIdentityId, provider_user_id: CREATED,
    });
    expect(journal[0].email_hash).not.toContain(EMAIL);
    const binding = await pool.query(
      'SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1', [CREATED],
    );
    expect(binding.rows).toEqual([{ identity_id: hostIdentityId, is_primary: false }]);
    expect(await getAuthorizationFingerprint([HOST, CREATED])).toBe(
      `${HOST}:epoch:1,${CREATED}:epoch:1`,
    );
    expect(await getAuthorizationFingerprint([HOST_SIBLING])).toBe(`${HOST_SIBLING}:epoch:1`);
    const organizationPointers = await pool.query(
      `SELECT workos_user_id, primary_organization_id FROM users WHERE workos_user_id = ANY($1)
       ORDER BY workos_user_id`, [[HOST, CREATED]],
    );
    expect(organizationPointers.rows).toEqual([
      { workos_user_id: HOST, primary_organization_id: ORG },
      { workos_user_id: CREATED, primary_organization_id: null },
    ]);
    const memberships = await pool.query(
      `SELECT workos_user_id, role FROM organization_memberships WHERE workos_organization_id = $1`, [ORG],
    );
    expect(memberships.rows).toEqual([{ workos_user_id: HOST, role: 'admin' }]);
    const audit = await pool.query(
      `SELECT details FROM registry_audit_log WHERE action = 'admin_credential_bind'
       AND resource_id = $1 ORDER BY created_at`, [journal[0].id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows).toEqual(expect.arrayContaining([{
      details: expect.objectContaining({
        status: 'committed', acting_workos_user_id: ACTOR_CREDENTIAL, actor_identity_id: actorIdentityId,
      }),
    }]));
    expect(provider.deleteUser).not.toHaveBeenCalled();
    assertNoProviderReadsOrMembershipWrites();
  });

  it('records a definite provider rejection before any local credential mutation and permits a safe retry', async () => {
    provider.createUser.mockRejectedValueOnce(Object.assign(new Error(SECRET), { status: 422 }));

    const rejected = await createAndBindAdminCredential(input());

    expect(rejected.status).toBeGreaterThanOrEqual(400);
    await expectNoLocalCredential();
    expect((await operations())[0].status).toBe('provider_rejected');
    expect(provider.deleteUser).not.toHaveBeenCalled();
    const retry = await createAndBindAdminCredential(input());
    expect(retry.status).toBe(201);
    expect(provider.createUser).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(SECRET);
  });

  it('retains a safe provider ID for adjudication when creation returns a different email', async () => {
    provider.createUser.mockResolvedValueOnce({ ...createdUser(), email: 'priya.new@admin-bind.example' });

    const result = await createAndBindAdminCredential(input());

    expect(result.body).toMatchObject({ reconciliation_required: true, new_workos_user_id: CREATED });
    const journal = (await operations())[0];
    expect(journal).toMatchObject({
      status: 'reconciliation_required', provider_user_id: CREATED, failure_code: 'provider_response_invalid',
    });
    const audit = await pool.query('SELECT details FROM registry_audit_log WHERE resource_id = $1', [journal.id]);
    expect(audit.rows).toContainEqual({ details: expect.objectContaining({ provider_user_id: CREATED }) });
    await expectNoLocalCredential();
    expect((await createAndBindAdminCredential(input())).body.reconciliation_required).toBe(true);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    assertNoProviderReadsOrMembershipWrites();
  });

  it('does not adopt or delete a provider credential materialized locally by a concurrent webhook', async () => {
    let webhookIdentityId: string | undefined;
    provider.createUser.mockImplementationOnce(async () => {
      await insertUser(CREATED, EMAIL, 'Sam', 'Adeyemi');
      webhookIdentityId = await identityOf(CREATED);
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
         VALUES ($1, $2, $3, 'member')`, [CREATED, ORG, EMAIL],
      );
      return createdUser();
    });

    const result = await createAndBindAdminCredential(input());

    expect(result.body.reconciliation_required).toBe(true);
    expect((await operations())[0]).toMatchObject({
      status: 'reconciliation_required', provider_user_id: CREATED, failure_code: 'local_user_already_exists',
    });
    expect(await identityOf(CREATED)).toBe(webhookIdentityId);
    expect(webhookIdentityId).not.toBe(hostIdentityId);
    const memberships = await pool.query(
      'SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
      [CREATED, ORG],
    );
    expect(memberships.rows).toEqual([{ role: 'member' }]);
    expect(await getAuthorizationFingerprint([HOST, HOST_SIBLING, CREATED])).toBe('');
    expect((await createAndBindAdminCredential(input())).body.reconciliation_required).toBe(true);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    assertNoProviderReadsOrMembershipWrites();
  });

  it('rolls back the local transaction and deletes exactly the newly created provider user', async () => {
    await failLocalInsert();
    provider.deleteUser.mockImplementation(async (id) => {
      expect(id).toBe(CREATED);
      await expectNoLocalCredential();
    });

    const result = await createAndBindAdminCredential(input());

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    await expectNoLocalCredential();
    expect((await operations())[0]).toMatchObject({ status: 'compensated', provider_user_id: CREATED });
    assertNoProviderReadsOrMembershipWrites();
  });

  it('permits a new operation after verified compensation without replaying the old operation', async () => {
    await failLocalInsert();
    await createAndBindAdminCredential(input());
    const first = (await operations())[0];
    expect(first.status).toBe('compensated');
    await pool.query('DROP TRIGGER admin_bind_test_fail_insert ON users');
    // WorkOS allocates a new ID; a deleted ID must never be resurrected.
    provider.createUser.mockResolvedValueOnce({ ...createdUser(), id: `${CREATED}_retry` });

    expect((await createAndBindAdminCredential(input())).status).toBe(201);

    const journal = await operations();
    expect(journal).toHaveLength(2);
    expect(journal.find((operation) => operation.id === first.id)?.status).toBe('compensated');
    expect(provider.createUser).toHaveBeenCalledTimes(2);
    expect(provider.deleteUser).toHaveBeenCalledTimes(1);
  });

  it('rolls back the inserted user, binding, and epochs if the transactional commit audit fails', async () => {
    await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected journal write failure'; END;
    $$`);
    await pool.query(`CREATE TRIGGER admin_bind_test_fail_audit BEFORE INSERT ON registry_audit_log
      FOR EACH ROW WHEN (NEW.action = 'admin_credential_bind'
        AND NEW.details->>'status' = 'committed' AND NEW.details->>'host_user_id' = '${HOST}')
      EXECUTE FUNCTION admin_bind_test_fail_journal()`);

    const result = await createAndBindAdminCredential(input());

    expect(result.body.compensated).toBe(true);
    await expectNoLocalCredential();
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    const journal = (await operations())[0];
    expect(journal.status).toBe('compensated');
    const committed = await pool.query(
      `SELECT 1 FROM registry_audit_log WHERE resource_id = $1 AND details->>'status' = 'committed'`, [journal.id],
    );
    expect(committed.rows).toEqual([]);
  });

  it('refuses provider creation if durable intent cannot be recorded', async () => {
    await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected journal write failure'; END;
    $$`);
    await pool.query(`CREATE TRIGGER admin_bind_test_fail_intent BEFORE INSERT ON admin_credential_bind_operations
      FOR EACH ROW WHEN (NEW.host_user_id = '${HOST}') EXECUTE FUNCTION admin_bind_test_fail_journal()`);

    const result = await createAndBindAdminCredential(input());

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(await operations()).toEqual([]);
    await expectNoLocalCredential();
  });

  it('retains support-safe durable evidence when compensation fails and blocks replay across hosts', async () => {
    await failLocalInsert();
    provider.deleteUser.mockRejectedValueOnce(Object.assign(new Error(SECRET), {
      status: 503, response: { accessToken: SECRET },
    }));

    const failed = await createAndBindAdminCredential(input());

    expect(failed.body.reconciliation_required).toBe(true);
    const journal = (await operations())[0];
    expect(journal).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
    expect(journal.failure_code).toBeTruthy();
    await expectNoLocalCredential();
    for (const hostUserId of [HOST, OTHER_HOST]) {
      const replay = await createAndBindAdminCredential(input({ hostUserId, email: `  ${EMAIL.toUpperCase()}  ` }));
      expect(replay.body.reconciliation_required).toBe(true);
    }
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).toHaveBeenCalledTimes(1);
    const audit = await pool.query('SELECT details FROM registry_audit_log WHERE resource_id = $1', [journal.id]);
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify({ journal, audit: audit.rows, failed, logs: Object.values(logs).map((log) => log.mock.calls) }))
      .not.toContain(SECRET);
    assertNoProviderReadsOrMembershipWrites();
  });

  it('retains the durable compensating intent if compensation and the reconciliation journal update both fail', async () => {
    await failLocalInsert();
    await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected reconciliation write failure'; END;
    $$`);
    await pool.query(`CREATE TRIGGER admin_bind_test_fail_reconciliation BEFORE UPDATE ON admin_credential_bind_operations
      FOR EACH ROW WHEN (NEW.host_user_id = '${HOST}' AND NEW.status = 'reconciliation_required')
      EXECUTE FUNCTION admin_bind_test_fail_journal()`);
    provider.deleteUser.mockRejectedValueOnce(new Error(SECRET));

    const result = await createAndBindAdminCredential(input());

    expect(result.body.reconciliation_required).toBe(true);
    const journal = (await operations())[0];
    expect(journal).toMatchObject({ status: 'compensating', provider_user_id: CREATED, failure_code: 'local_write_failed' });
    const audit = await pool.query('SELECT details FROM registry_audit_log WHERE resource_id = $1', [journal.id]);
    expect(audit.rows).toContainEqual({ details: expect.objectContaining({
      status: 'compensating', provider_user_id: CREATED, acting_workos_user_id: ACTOR_CREDENTIAL,
    }) });
    for (const hostUserId of [HOST, OTHER_HOST]) {
      expect((await createAndBindAdminCredential(input({ hostUserId }))).body.reconciliation_required).toBe(true);
    }
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    expect(logs.error).toHaveBeenCalledWith({ operationId: journal.id, failureCode: 'journal_update_failed' }, expect.any(String));
    expect(JSON.stringify({ journal, audit: audit.rows, result, logs: Object.values(logs).map((log) => log.mock.calls) }))
      .not.toContain(SECRET);
    await expectNoLocalCredential();
    assertNoProviderReadsOrMembershipWrites();
  });

  it('blocks replay after a timeout even when provider creation finishes after stale reads would report absence', async () => {
    const delayed = deferred<void>();
    let providerCompleted = false;
    provider.createUser.mockImplementationOnce(async () => {
      void delayed.promise.then(() => { providerCompleted = true; });
      throw Object.assign(new Error('provider response timeout'), { code: 'ETIMEDOUT' });
    });

    const timeout = await createAndBindAdminCredential(input());
    expect(timeout.body.reconciliation_required).toBe(true);
    expect(providerCompleted).toBe(false);
    expect((await operations())[0].status).toBe('reconciliation_required');
    expect((await createAndBindAdminCredential(input())).body.reconciliation_required).toBe(true);
    delayed.resolve();
    await delayed.promise;
    expect(providerCompleted).toBe(true);
    expect((await createAndBindAdminCredential(input({ hostUserId: OTHER_HOST }))).body.reconciliation_required).toBe(true);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    await expectNoLocalCredential();
    assertNoProviderReadsOrMembershipWrites();
  });

  it('does not infer compensation success after a delete timeout with delayed provider completion', async () => {
    await failLocalInsert();
    const delayed = deferred<void>();
    let providerDeleted = false;
    provider.deleteUser.mockImplementationOnce(async () => {
      void delayed.promise.then(() => { providerDeleted = true; });
      throw Object.assign(new Error('delete response timeout'), { code: 'ETIMEDOUT' });
    });

    const result = await createAndBindAdminCredential(input());
    expect(result.body.reconciliation_required).toBe(true);
    expect(providerDeleted).toBe(false);
    delayed.resolve();
    await delayed.promise;
    expect(providerDeleted).toBe(true);
    expect((await createAndBindAdminCredential(input())).body.reconciliation_required).toBe(true);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).toHaveBeenCalledTimes(1);
    expect((await operations())[0].status).toBe('reconciliation_required');
    assertNoProviderReadsOrMembershipWrites();
  });

  it('returns a verified committed replay without another provider write or epoch bump', async () => {
    expect((await createAndBindAdminCredential(input())).status).toBe(201);
    const before = await getAuthorizationFingerprint([HOST, CREATED]);

    const replay = await createAndBindAdminCredential(input({ email: ` ${EMAIL.toUpperCase()} ` }));

    expect(replay.status).toBe(200);
    expect(await operations()).toHaveLength(1);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(await getAuthorizationFingerprint([HOST, CREATED])).toBe(before);
  });

  it('refuses a committed replay when the credential no longer belongs to the recorded host identity', async () => {
    await createAndBindAdminCredential(input());
    await pool.query('UPDATE identity_workos_users SET identity_id = $1 WHERE workos_user_id = $2', [
      await identityOf(OTHER_HOST), CREATED,
    ]);

    const replay = await createAndBindAdminCredential(input());

    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.body.reconciliation_required).toBe(true);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it('serializes concurrent normalized-email requests across two host identities', async () => {
    const entered = deferred<void>();
    const finish = deferred<ReturnType<typeof createdUser>>();
    provider.createUser.mockImplementationOnce(() => {
      entered.resolve();
      return finish.promise;
    });
    const first = createAndBindAdminCredential(input());
    await entered.promise;
    // Keep WorkOS creation in flight until the competing request is refused;
    // this tests overlapping operations, not merely two sequential replays.
    const second = await createAndBindAdminCredential(input({ hostUserId: OTHER_HOST, email: EMAIL.toUpperCase() }));
    finish.resolve(createdUser());

    const firstResult = await first;

    expect(firstResult.status).toBe(201);
    expect(second.status).toBe(409);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(await identityOf(CREATED)).toBe(hostIdentityId);
    expect(await identityOf(OTHER_HOST)).not.toBe(hostIdentityId);
  });

  it.each(['absent credential', 'wrong identity'] as const)(
    'rejects an %s actor before creating a provider credential', async (scenario) => {
      const invalidActor = scenario === 'absent credential'
        ? { actorUserId: `${PREFIX}missing` }
        : { actorIdentityId: hostIdentityId };

      const result = await createAndBindAdminCredential(input(invalidActor));

      expect(result.status).toBe(403);
      expect(provider.createUser).not.toHaveBeenCalled();
      expect(await operations()).toEqual([]);
    },
  );

  it('rechecks the actor identity after provider creation and compensates if the credential moved', async () => {
    provider.createUser.mockImplementationOnce(async () => {
      await pool.query('UPDATE identity_workos_users SET identity_id = $1 WHERE workos_user_id = $2', [
        await identityOf(OTHER_HOST), ACTOR_CREDENTIAL,
      ]);
      return createdUser();
    });

    const result = await createAndBindAdminCredential(input());

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    expect((await operations())[0].status).toBe('compensated');
    await expectNoLocalCredential();
  });

  it('refuses a non-primary host before provider creation', async () => {
    const result = await createAndBindAdminCredential(input({ hostUserId: ACTOR_CREDENTIAL }));

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(await operations()).toEqual([]);
  });

  it('compensates instead of binding to a host whose identity changed during provider creation', async () => {
    provider.createUser.mockImplementationOnce(async () => {
      await pool.query('UPDATE identity_workos_users SET identity_id = $1, is_primary = false WHERE workos_user_id = $2', [
        await identityOf(OTHER_HOST), HOST,
      ]);
      return createdUser();
    });

    const result = await createAndBindAdminCredential(input());

    expect(result.body.compensated).toBe(true);
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    expect((await operations())[0].status).toBe('compensated');
    const local = await pool.query('SELECT 1 FROM users WHERE workos_user_id = $1', [CREATED]);
    expect(local.rows).toEqual([]);
    expect((await pool.query('SELECT 1 FROM authorization_epochs WHERE workos_user_id = ANY($1)',
      [[HOST, HOST_SIBLING, CREATED]])).rows).toEqual([]);
  });

  it('preserves the provider credential after a lost local COMMIT reply and requires adjudication', async () => {
    const fault = faultPool('commit_reply_lost');

    const result = await createAndBindAdminCredential(input(), { pool: fault.pool, workos: provider });

    expect(fault.wasInjected()).toBe(true);
    expect(result.body.reconciliation_required).toBe(true);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    // The transaction really committed; deleting WorkOS here would break the
    // successfully bound credential despite the caller receiving an error.
    expect(await identityOf(CREATED)).toBe(hostIdentityId);
    expect((await operations())[0].status).toBe('reconciliation_required');
    expect((await createAndBindAdminCredential(input())).body.reconciliation_required).toBe(true);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
  });

  it('discards the connection and preserves the provider credential when local rollback is unconfirmed', async () => {
    await failLocalInsert();
    const fault = faultPool('rollback_reply_lost');

    const result = await createAndBindAdminCredential(input(), { pool: fault.pool, workos: provider });

    expect(fault.wasInjected()).toBe(true);
    expect(fault.releases.some((release) => release === true || release instanceof Error)).toBe(true);
    expect(result.body.reconciliation_required).toBe(true);
    expect(result.body.compensated).not.toBe(true);
    expect((await operations())[0]).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
    expect(provider.deleteUser).not.toHaveBeenCalled();
    await expectNoLocalCredential();
    expect((await createAndBindAdminCredential(input())).body.reconciliation_required).toBe(true);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    assertNoProviderReadsOrMembershipWrites();
  });

  it('refuses provider writes when advisory lock acquisition returns false', async () => {
    const fault = faultPool('lock_false');

    const result = await createAndBindAdminCredential(input(), { pool: fault.pool, workos: provider });

    expect(fault.wasInjected()).toBe(true);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(await operations()).toEqual([]);
  });

  it('destroys the pooled connection and reports reconciliation if advisory unlock is not confirmed', async () => {
    const fault = faultPool('unlock_false');

    const result = await createAndBindAdminCredential(input(), { pool: fault.pool, workos: provider });

    expect(fault.wasInjected()).toBe(true);
    expect(result.body.reconciliation_required).toBe(true);
    expect(fault.releases.some((release) => release === true || release instanceof Error)).toBe(true);
    expect((await operations())[0].status).toBe('reconciliation_required');
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it.each(['lock_reply_lost', 'lock_reply_malformed'] as const)(
    'destroys the pooled connection when acquisition outcome is uncertain (%s)', async (mode) => {
      const fault = faultPool(mode);

      const result = await createAndBindAdminCredential(input(), { pool: fault.pool, workos: provider });

      expect(fault.wasInjected()).toBe(true);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(fault.releases.some((release) => release === true || release instanceof Error)).toBe(true);
      expect(provider.createUser).not.toHaveBeenCalled();
      expect(await operations()).toEqual([]);
    },
  );
});
