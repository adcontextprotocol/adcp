/**
 * Admin create-and-bind uses real PostgreSQL transactions and a mocked WorkOS
 * boundary. Transport faults deliberately leave the provider outcome unknown;
 * a stale provider read cannot authorize replay or destructive compensation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';

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

  function intentFaultPool(intercept: (
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>, sql: string, params?: unknown[],
  ) => Promise<QueryResult>) {
    const releases: Array<boolean | Error | undefined> = [];
    const proxy = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect') return async () => {
          const client = await target.connect();
          const query = client.query.bind(client);
          const release = client.release.bind(client);
          client.query = ((sql: string, params?: unknown[]) => intercept(query, sql, params)) as PoolClient['query'];
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
    return { pool: proxy, releases };
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

  it('records a definite provider rejection and keeps repeat admission blocked until adjudication', async () => {
    provider.createUser.mockRejectedValueOnce(Object.assign(new Error(SECRET), { status: 422 }));

    const rejected = await createAndBindAdminCredential(input());

    expect(rejected.status).toBeGreaterThanOrEqual(400);
    await expectNoLocalCredential();
    expect((await operations())[0].status).toBe('provider_rejected');
    expect(provider.deleteUser).not.toHaveBeenCalled();
    const retry = await createAndBindAdminCredential(input());
    expect(retry.body).toMatchObject({ reconciliation_required: true, operation_id: rejected.body.operation_id });
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(SECRET);
  });

  it('never commits an unaudited provider-created or reconciliation transition when audit triggers suppress both', async () => {
    await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END;
    $$`);
    await pool.query(`CREATE TRIGGER admin_bind_test_fail_audit BEFORE INSERT ON registry_audit_log
      FOR EACH ROW WHEN (NEW.action = 'admin_credential_bind'
        AND NEW.details->>'status' IN ('provider_created', 'reconciliation_required')
        AND NEW.details->>'host_user_id' = '${HOST}')
      EXECUTE FUNCTION admin_bind_test_fail_journal()`);

    const result = await createAndBindAdminCredential(input());
    expect(result.body.reconciliation_required).toBe(true);
    const [operation] = await operations();
    expect(operation).toMatchObject({ status: 'creating', provider_user_id: null, failure_code: null });
    expect((await pool.query('SELECT details FROM registry_audit_log WHERE resource_id = $1', [operation.id])).rows)
      .toEqual([{ details: expect.objectContaining({ status: 'creating', provider_user_id: null }) }]);
    expect((await createAndBindAdminCredential(input())).body.operation_id).toBe(operation.id);
    await expectNoLocalCredential();
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it('never claims compensation if a trigger alters the confirmed-deletion marker', async () => {
    await failLocalInsert();
    await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.details = jsonb_set(NEW.details, '{provider_delete_confirmed}', 'false'); RETURN NEW; END;
    $$`);
    await pool.query(`CREATE TRIGGER admin_bind_test_fail_audit BEFORE INSERT ON registry_audit_log
      FOR EACH ROW WHEN (NEW.action = 'identity_credential_admin_compensation_deleted'
        AND NEW.workos_user_id = '${CREATED}') EXECUTE FUNCTION admin_bind_test_fail_journal()`);

    const result = await createAndBindAdminCredential(input());
    expect(result.body.compensated).not.toBe(true);
    expect(result.body.reconciliation_required).toBe(true);
    const [operation] = await operations();
    expect(operation.status).toBe('reconciliation_required');
    expect((await pool.query(`SELECT 1 FROM registry_audit_log
      WHERE workos_user_id = $1 AND action = 'identity_credential_admin_compensation_deleted'`, [CREATED])).rows).toEqual([]);
    expect((await createAndBindAdminCredential(input())).body.operation_id).toBe(operation.id);
    await expectNoLocalCredential();
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
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

  it('keeps verified compensation history reserved without replaying the old operation', async () => {
    await failLocalInsert();
    await createAndBindAdminCredential(input());
    const first = (await operations())[0];
    expect(first.status).toBe('compensated');
    await pool.query('DROP TRIGGER admin_bind_test_fail_insert ON users');
    // WorkOS allocates a new ID; a deleted ID must never be resurrected.
    provider.createUser.mockResolvedValueOnce({ ...createdUser(), id: `${CREATED}_retry` });

    expect((await createAndBindAdminCredential(input())).body).toMatchObject({
      reconciliation_required: true, operation_id: first.id,
    });

    const journal = await operations();
    expect(journal).toHaveLength(1);
    expect(journal.find((operation) => operation.id === first.id)?.status).toBe('compensated');
    expect(provider.createUser).toHaveBeenCalledTimes(1);
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

  it.each(['suppressed', 'exception'] as const)('refuses provider creation if durable intent is %s', async (fault) => {
    await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${fault === 'suppressed' ? 'RETURN NULL;' : "RAISE EXCEPTION 'injected journal write failure';"} END;
    $$`);
    await pool.query(`CREATE TRIGGER admin_bind_test_fail_intent BEFORE INSERT ON admin_credential_bind_operations
      FOR EACH ROW WHEN (NEW.host_user_id = '${HOST}') EXECUTE FUNCTION admin_bind_test_fail_journal()`);

    const result = await createAndBindAdminCredential(input());

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(await operations()).toEqual([]);
    await expectNoLocalCredential();
  });

  it.each(['suppressed', 'exception'] as const)(
    'rolls back the initial intent when its mandatory audit is %s, before any provider call', async (fault) => {
      await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN ${fault === 'suppressed' ? 'RETURN NULL;' : "RAISE EXCEPTION 'injected initial audit failure';"} END;
      $$`);
      await pool.query(`CREATE TRIGGER admin_bind_test_fail_audit BEFORE INSERT ON registry_audit_log
        FOR EACH ROW WHEN (NEW.action = 'admin_credential_bind'
          AND NEW.details->>'status' = 'creating' AND NEW.details->>'host_user_id' = '${HOST}')
        EXECUTE FUNCTION admin_bind_test_fail_journal()`);

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await createAndBindAdminCredential(input());
        expect(result.status).toBe(503);
        expect(result.body.bound).toBeUndefined();
        expect(await operations()).toEqual([]);
        expect((await pool.query(`SELECT 1 FROM registry_audit_log
          WHERE action = 'admin_credential_bind' AND details->>'host_user_id' = $1`, [HOST])).rows).toEqual([]);
        await expectNoLocalCredential();
      }
      expect(provider.createUser).not.toHaveBeenCalled();
      expect(provider.deleteUser).not.toHaveBeenCalled();
      assertNoProviderReadsOrMembershipWrites();
    },
  );

  it('commits exactly one initial operation and actor-attributed audit before the provider call', async () => {
    provider.createUser.mockImplementationOnce(async () => {
      // This pool query uses an independent session from the saga's client.
      const journal = await operations();
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({ status: 'creating', provider_user_id: null });
      const audit = await pool.query(`SELECT id, workos_user_id, details FROM registry_audit_log
        WHERE resource_id = $1`, [journal[0].id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ id: expect.any(String), workos_user_id: ACTOR_CREDENTIAL,
        details: { status: 'creating', failure_code: null, acting_workos_user_id: ACTOR_CREDENTIAL,
          actor_identity_id: actorIdentityId, host_user_id: HOST, host_identity_id: hostIdentityId,
          provider_user_id: null } });
      return createdUser();
    });
    expect((await createAndBindAdminCredential(input())).status).toBe(201);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
  });

  it.each(['operation', 'audit'] as const)('requires exact %s intent receipt cardinality and identity', async (target) => {
    for (const fault of ['zero', 'null_count', 'multiple_count', 'missing', 'multiple_rows', 'null_id', 'wrong_id', 'wrong_status']) {
      let injected = false;
      const transport = intentFaultPool(async (query, sql, params) => {
        const receipt = await query(sql, params);
        const matches = target === 'operation' ? sql.includes('INSERT INTO admin_credential_bind_operations')
          : sql.includes('INSERT INTO registry_audit_log');
        if (injected || !matches) return receipt;
        injected = true;
        if (fault === 'zero') return { ...receipt, rowCount: 0 };
        if (fault === 'null_count') return { ...receipt, rowCount: null };
        if (fault === 'multiple_count') return { ...receipt, rowCount: 2 };
        if (fault === 'missing') return { ...receipt, rows: [] };
        if (fault === 'multiple_rows') return { ...receipt, rows: [...receipt.rows, ...receipt.rows] };
        if (fault === 'null_id') return { ...receipt, rows: [{ ...receipt.rows[0], id: null }] };
        if (fault === 'wrong_status') return { ...receipt, rows: [{ ...receipt.rows[0],
          ...(target === 'operation' ? { status: 'committed' } : { action: 'unrelated_event' }) }] };
        return { ...receipt, rows: [{ ...receipt.rows[0],
          ...(target === 'operation' ? { actor_user_id: HOST } : { resource_id: 'wrong-operation' }) }] };
      });
      const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
      expect(injected, fault).toBe(true);
      expect(result.status, fault).toBe(503);
      expect(result.body.operation_id, fault).toBeUndefined();
      expect(await operations(), fault).toEqual([]);
      expect((await pool.query(`SELECT 1 FROM registry_audit_log
        WHERE action = 'admin_credential_bind' AND details->>'host_user_id' = $1`, [HOST])).rows).toEqual([]);
      await expectNoLocalCredential();
    }
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(provider.deleteUser).not.toHaveBeenCalled();
    assertNoProviderReadsOrMembershipWrites();
  });

  it.each(['before_send', 'reply_lost', 'wrong_command'] as const)(
    'reserves the exact intent after ambiguous initial COMMIT (%s) and blocks replay without WorkOS', async (fault) => {
      let injected = false;
      const transport = intentFaultPool(async (query, sql, params) => {
        if (injected || sql.trim() !== 'COMMIT') return query(sql, params);
        injected = true;
        if (fault === 'before_send') throw new Error(SECRET);
        const receipt = await query(sql, params);
        if (fault === 'reply_lost') throw new Error(SECRET);
        return { ...receipt, command: 'UNKNOWN' };
      });
      const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ reconciliation_required: true, new_workos_user_id: null });
      const journal = await operations();
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({ id: result.body.operation_id, status: 'reconciliation_required',
        failure_code: 'intent_commit_ambiguous', provider_user_id: null,
        actor_user_id: ACTOR_CREDENTIAL, actor_identity_id: actorIdentityId, host_identity_id: hostIdentityId });
      const audit = await pool.query(`SELECT details FROM registry_audit_log WHERE resource_id = $1
        AND details->>'status' = 'reconciliation_required'`, [journal[0].id]);
      expect(audit.rows).toEqual([{ details: expect.objectContaining({ failure_code: 'intent_commit_ambiguous' }) }]);
      for (const hostUserId of [HOST, OTHER_HOST]) {
        const replay = await createAndBindAdminCredential(input({ hostUserId }));
        expect(replay.body).toMatchObject({ reconciliation_required: true, operation_id: journal[0].id });
        expect(replay.body.bound).toBeUndefined();
      }
      expect(await operations()).toEqual(journal);
      await expectNoLocalCredential();
      expect(provider.createUser).not.toHaveBeenCalled();
      expect(provider.deleteUser).not.toHaveBeenCalled();
      assertNoProviderReadsOrMembershipWrites();
      expect(JSON.stringify(logs.error.mock.calls)).not.toContain(SECRET);
    },
  );

  it('serializes delayed initial COMMIT with concurrent replay in independent DB sessions', async () => {
    const committing = deferred<void>();
    const finishCommit = deferred<void>();
    let injected = false;
    const transport = intentFaultPool(async (query, sql, params) => {
      if (injected || sql.trim() !== 'COMMIT') return query(sql, params);
      injected = true;
      committing.resolve();
      await finishCommit.promise;
      await query(sql, params);
      throw new Error(SECRET);
    });
    const pending = createAndBindAdminCredential(input(), { pool: transport.pool });
    await committing.promise;
    try {
      expect(await operations()).toEqual([]); // Initial transaction is still in flight.
      const concurrent = await createAndBindAdminCredential(input({ hostUserId: OTHER_HOST }));
      expect(concurrent.body.error).toBe('credential_bind_in_progress');
      expect(provider.createUser).not.toHaveBeenCalled();
    } finally { finishCommit.resolve(); }
    const result = await pending;
    expect(result.body.reconciliation_required).toBe(true);
    expect((await createAndBindAdminCredential(input())).body).toMatchObject({
      reconciliation_required: true, operation_id: result.body.operation_id,
    });
    expect(await operations()).toHaveLength(1);
    await expectNoLocalCredential();
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it('discards an unconfirmed intent rollback and durably reserves reconciliation on another session', async () => {
    let failedAudit = false;
    let failedRollback = false;
    const transport = intentFaultPool(async (query, sql, params) => {
      if (!failedAudit && sql.includes('INSERT INTO registry_audit_log')) {
        failedAudit = true;
        throw new Error(SECRET);
      }
      const receipt = await query(sql, params);
      if (!failedRollback && sql.trim() === 'ROLLBACK') {
        failedRollback = true;
        throw new Error(SECRET);
      }
      return receipt;
    });
    const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
    expect(transport.releases).toContain(true);
    expect(result.body.reconciliation_required).toBe(true);
    expect((await operations())[0]).toMatchObject({ id: result.body.operation_id, status: 'reconciliation_required' });
    expect((await createAndBindAdminCredential(input())).body.operation_id).toBe(result.body.operation_id);
    await expectNoLocalCredential();
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    { fault: 'suppressed', applied: true }, { fault: 'exception', applied: true },
    { fault: 'suppressed', applied: false }, { fault: 'exception', applied: false },
  ])(
    'exposes unknown recovery audit $fault after initial COMMIT applied=$applied', async ({ fault, applied }) => {
      await pool.query(`CREATE FUNCTION admin_bind_test_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN ${fault === 'suppressed' ? 'RETURN NULL;' : "RAISE EXCEPTION 'injected recovery audit failure';"} END;
      $$`);
      await pool.query(`CREATE TRIGGER admin_bind_test_fail_audit BEFORE INSERT ON registry_audit_log
        FOR EACH ROW WHEN (NEW.action = 'admin_credential_bind'
          AND NEW.details->>'status' = 'reconciliation_required' AND NEW.details->>'host_user_id' = '${HOST}')
        EXECUTE FUNCTION admin_bind_test_fail_journal()`);
      let injected = false;
      const transport = intentFaultPool(async (query, sql, params) => {
        if (!injected && !applied && sql.trim() === 'COMMIT') { injected = true; throw new Error(SECRET); }
        const receipt = await query(sql, params);
        if (!injected && sql.trim() === 'COMMIT') { injected = true; throw new Error(SECRET); }
        return receipt;
      });
      const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
      expect(result.body).toMatchObject({ reconciliation_required: true, new_workos_user_id: null,
        intent_persistence: 'unconfirmed', provider_creation_attempted: false });
      expect(result.body.compensated).toBeUndefined();
      const journal = await operations();
      expect(journal).toHaveLength(applied ? 1 : 0);
      if (applied) {
        expect(journal[0]).toMatchObject({ id: result.body.operation_id, status: 'creating', failure_code: null });
        expect((await createAndBindAdminCredential(input())).body.operation_id).toBe(journal[0].id);
      }
      expect(logs.error).toHaveBeenCalledWith(expect.objectContaining({
        operationId: result.body.operation_id, failureCode: 'intent_reconciliation_unconfirmed',
      }), expect.any(String));
      expect(JSON.stringify(logs.error.mock.calls)).not.toContain(SECRET);
      await expectNoLocalCredential();
      expect(provider.createUser).not.toHaveBeenCalled();
      expect(provider.deleteUser).not.toHaveBeenCalled();
    },
  );

  it.each(['audit_cardinality', 'lock_receipt', 'commit_before_send', 'commit_reply_lost', 'commit_wrong_command'] as const)(
    'keeps ambiguous admission blocked when recovery has a %s fault', async (fault) => {
      let initialCommitLost = false;
      let recoveryFault = false;
      const transport = intentFaultPool(async (query, sql, params) => {
        if (!initialCommitLost && sql.trim() === 'COMMIT') {
          await query(sql, params);
          initialCommitLost = true;
          throw new Error(SECRET);
        }
        if (initialCommitLost && !recoveryFault) {
          if (fault === 'commit_before_send' && sql.trim() === 'COMMIT') {
            recoveryFault = true;
            throw new Error(SECRET);
          }
          const receipt = await query(sql, params);
          if (fault === 'audit_cardinality' && sql.includes('INSERT INTO registry_audit_log')) {
            recoveryFault = true;
            return { ...receipt, rowCount: 0 };
          }
          if (fault === 'lock_receipt' && sql.includes('pg_try_advisory_xact_lock')) {
            recoveryFault = true;
            return { ...receipt, rows: [] };
          }
          if (fault === 'commit_reply_lost' && sql.trim() === 'COMMIT') {
            recoveryFault = true;
            throw new Error(SECRET);
          }
          if (fault === 'commit_wrong_command' && sql.trim() === 'COMMIT') {
            recoveryFault = true;
            return { ...receipt, command: 'UNKNOWN' };
          }
          return receipt;
        }
        return query(sql, params);
      });
      const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
      expect(recoveryFault).toBe(true);
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ reconciliation_required: true, new_workos_user_id: null });
      const journal = await operations();
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({ id: result.body.operation_id,
        status: ['commit_reply_lost', 'commit_wrong_command'].includes(fault) ? 'reconciliation_required' : 'creating' });
      expect((await createAndBindAdminCredential(input())).body.operation_id).toBe(journal[0].id);
      await expectNoLocalCredential();
      expect(provider.createUser).not.toHaveBeenCalled();
      expect(provider.deleteUser).not.toHaveBeenCalled();
      assertNoProviderReadsOrMembershipWrites();
    },
  );

  it.each(['provider_progressed', 'actor_changed', 'host_changed'] as const)(
    'never overwrites a %s operation while recovering ambiguous intent', async (fault) => {
      let operationId: string | undefined;
      let injected = false;
      let changed: Operation | undefined;
      const transport = intentFaultPool(async (query, sql, params) => {
        const receipt = await query(sql, params);
        if (!operationId && sql.includes('INSERT INTO admin_credential_bind_operations')) operationId = receipt.rows[0].id;
        if (!injected && sql.trim() === 'COMMIT') {
          injected = true;
          const update = fault === 'provider_progressed' ? "status = 'provider_created', provider_user_id = $2"
            : fault === 'actor_changed' ? 'actor_user_id = $2' : 'host_user_id = $2';
          const value = fault === 'provider_progressed' ? CREATED : fault === 'actor_changed' ? ACTOR_PRIMARY : OTHER_HOST;
          // Independent connection models operator/interleaving changes while
          // the intent's COMMIT acknowledgment is missing.
          changed = (await pool.query<Operation>(`UPDATE admin_credential_bind_operations SET ${update}
            WHERE id = $1 RETURNING *`, [operationId, value])).rows[0];
          throw new Error(SECRET);
        }
        return receipt;
      });
      const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
      expect(result.body).toMatchObject({ reconciliation_required: true, operation_id: operationId,
        intent_persistence: 'unconfirmed', provider_creation_attempted: false });
      expect(await operations()).toEqual([changed]);
      expect((await createAndBindAdminCredential(input())).body.operation_id).toBe(operationId);
      expect(await operations()).toEqual([changed]);
      await expectNoLocalCredential();
      expect(provider.createUser).not.toHaveBeenCalled();
      expect(provider.deleteUser).not.toHaveBeenCalled();
    },
  );

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
  describe('mandatory transition and compensation audit integrity', () => {
    type Phase = 'creating' | 'provider_rejected' | 'provider_created'
      | 'reconciliation_required' | 'committed' | 'compensating' | 'compensated'
      | 'quarantine_marker' | 'confirmed_marker';
    type Fault = 'before_null' | 'before_alter' | 'after_delete'
      | 'deferred_delete' | 'deferred_alter' | 'deferred_exception';
    interface AuditRow {
      id: string;
      workos_organization_id: string;
      workos_user_id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      details: Record<string, unknown>;
    }
    interface Evidence { operation: Operation & { receipt_version: string }; audits: AuditRow[] }
    interface Observation { sql: string; providerCalled: boolean; evidence: Evidence[] }

    const quarantineAction = 'identity_credential_admin_compensation_quarantined';
    const confirmedAction = 'identity_credential_admin_compensation_deleted';
    const faultName = 'admin_bind_transition_integrity_fault';
    const phases: Phase[] = [
      'creating', 'provider_rejected', 'provider_created', 'reconciliation_required',
      'committed', 'compensating', 'compensated', 'quarantine_marker', 'confirmed_marker',
    ];
    const faults: Fault[] = [
      'before_null', 'before_alter', 'after_delete',
      'deferred_delete', 'deferred_alter', 'deferred_exception',
    ];
    let observations: Observation[];
    let beforeProvider: Evidence[] | undefined;

    beforeEach(() => {
      observations = [];
      beforeProvider = undefined;
    });
    afterEach(async () => {
      await pool.query('DROP TRIGGER IF EXISTS ' + faultName + ' ON registry_audit_log');
      await pool.query('DROP FUNCTION IF EXISTS ' + faultName + '()');
    });

    function literal(value: string) { return "'" + value.replace(/'/g, "''") + "'"; }

    function phasePredicate(phase: Phase) {
      if (phase === 'quarantine_marker' || phase === 'confirmed_marker') {
        const action = phase === 'quarantine_marker' ? quarantineAction : confirmedAction;
        return 'NEW.action = ' + literal(action)
          + ' AND EXISTS (SELECT 1 FROM admin_credential_bind_operations operation'
          + ' WHERE operation.id::text = NEW.resource_id AND operation.host_user_id = ' + literal(HOST) + ')';
      }
      return "NEW.action = 'admin_credential_bind'"
        + " AND NEW.details->>'status' = " + literal(phase)
        + " AND NEW.details->>'host_user_id' = " + literal(HOST);
    }

    async function installAuditFault(phase: Phase, fault: Fault) {
      const before = fault.startsWith('before_');
      const deferred = fault.startsWith('deferred_');
      let mutation: string;
      if (fault === 'before_null') mutation = 'RETURN NULL;';
      else if (fault === 'before_alter') {
        // Same identity, wrong authenticated credential: an id-only or
        // cardinality-only receipt cannot detect this attribution corruption.
        mutation = "NEW.details := jsonb_set(NEW.details, '{acting_workos_user_id}',"
          + ' to_jsonb(' + literal(ACTOR_PRIMARY) + '::text)); RETURN NEW;';
      } else if (fault.endsWith('_delete')) {
        mutation = 'DELETE FROM registry_audit_log WHERE id = NEW.id; RETURN NULL;';
      } else if (fault === 'deferred_alter') {
        mutation = 'UPDATE registry_audit_log SET details = jsonb_set(details,'
          + " '{acting_workos_user_id}', to_jsonb(" + literal(ACTOR_PRIMARY) + '::text))'
          + ' WHERE id = NEW.id; RETURN NULL;';
      } else {
        mutation = "RAISE EXCEPTION 'injected deferred mandatory audit failure';";
      }
      await pool.query(
        'CREATE FUNCTION ' + faultName + '() RETURNS trigger LANGUAGE plpgsql AS $$'
        + ' BEGIN IF ' + phasePredicate(phase) + ' THEN ' + mutation + ' END IF;'
        + ' RETURN NEW; END; $$',
      );
      await pool.query(
        'CREATE ' + (deferred ? 'CONSTRAINT ' : '') + 'TRIGGER ' + faultName
        + (before ? ' BEFORE' : ' AFTER') + ' INSERT ON registry_audit_log'
        + (deferred ? ' DEFERRABLE INITIALLY DEFERRED' : '')
        + ' FOR EACH ROW EXECUTE FUNCTION ' + faultName + '()',
      );
    }

    async function evidence(): Promise<Evidence[]> {
      return (await pool.query<Evidence>(
        "SELECT to_jsonb(operation) || jsonb_build_object('receipt_version', operation.xmin::text || ':' || operation.ctid::text) AS operation,"
        + ' COALESCE((SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)'
        + ' FROM registry_audit_log audit WHERE audit.resource_id = operation.id::text),'
        + " '[]'::jsonb) AS audits"
        + ' FROM admin_credential_bind_operations operation'
        + ' WHERE operation.host_user_id = $1 ORDER BY operation.created_at, operation.id',
        [HOST],
      )).rows;
    }

    function observedPool() {
      return intentFaultPool(async (query, sql, params) => {
        try {
          return await query(sql, params);
        } finally {
          if ((sql.includes('admin_credential_bind_operations') && /\b(?:INSERT|UPDATE)\b/i.test(sql))
            || sql.includes('INSERT INTO registry_audit_log')
            || ['COMMIT', 'ROLLBACK'].includes(sql.trim())) {
            observations.push({
              sql,
              providerCalled: provider.createUser.mock.calls.length > 0,
              evidence: await evidence(),
            });
          }
        }
      }).pool;
    }

    function exactOperationAudit(row: AuditRow, op: Evidence['operation']) {
      return row.action === 'admin_credential_bind'
        && row.workos_organization_id === 'system'
        && row.workos_user_id === ACTOR_CREDENTIAL
        && row.resource_type === 'admin_credential_bind_operation'
        && row.resource_id === op.id
        && row.details.status === op.status
        && row.details.operation_version === op.receipt_version
        && row.details.failure_code === op.failure_code
        && row.details.acting_workos_user_id === ACTOR_CREDENTIAL
        && row.details.actor_identity_id === actorIdentityId
        && row.details.host_user_id === HOST
        && row.details.host_identity_id === hostIdentityId
        && row.details.provider_user_id === op.provider_user_id;
    }

    function exactMarker(row: AuditRow, op: Operation, confirmed: boolean) {
      return row.action === (confirmed ? confirmedAction : quarantineAction)
        && row.workos_organization_id === 'system'
        && row.workos_user_id === CREATED
        && row.resource_type === 'admin_credential_bind_operation'
        && row.resource_id === op.id
        && row.details.operation_id === op.id
        && row.details.acting_workos_user_id === ACTOR_CREDENTIAL
        && row.details.actor_identity_id === actorIdentityId
        && row.details.provider_delete_confirmed === confirmed
        && (confirmed
          ? row.details.deleted_workos_user_id === CREATED
            && row.details.deletion_source === 'admin_credential_compensation'
          : row.details.provider_user_id === CREATED
            && row.details.quarantine_reason === 'admin_credential_compensation_pending');
    }

    function expectConsistentVisibleState() {
      for (const [index, snapshot] of observations.entries()) {
        const at = 'observation ' + index + ': ' + snapshot.sql.slice(0, 100);
        if (snapshot.providerCalled) expect(snapshot.evidence, at).toHaveLength(1);
        for (const item of snapshot.evidence) {
          const op = item.operation;
          expect(op, at).toMatchObject({
            actor_user_id: ACTOR_CREDENTIAL, actor_identity_id: actorIdentityId,
            host_user_id: HOST, host_identity_id: hostIdentityId,
          });
          expect(item.audits.filter(row => exactOperationAudit(row, op)), at).toHaveLength(1);
          if (op.status === 'compensating' || op.status === 'compensated') {
            expect(item.audits.filter(row => exactMarker(row, op, false)), at).toHaveLength(1);
          }
          if (op.status === 'compensated') {
            expect(item.audits.filter(row => exactMarker(row, op, true)), at).toHaveLength(1);
          }
        }
      }
    }

    async function arrange(phase: Phase) {
      if (['compensating', 'compensated', 'quarantine_marker', 'confirmed_marker'].includes(phase)) {
        await failLocalInsert();
      }
      provider.createUser.mockImplementationOnce(async () => {
        beforeProvider = await evidence();
        if (phase === 'provider_rejected') {
          throw Object.assign(new Error(SECRET), { status: 422 });
        }
        if (phase === 'reconciliation_required') {
          throw Object.assign(new Error(SECRET), { code: 'ETIMEDOUT' });
        }
        return createdUser();
      });
    }

    async function expectFailureOutcome(phase: Phase, result: Awaited<ReturnType<typeof createAndBindAdminCredential>>) {
      expect(result.body.bound).not.toBe(true);
      expect(result.status).toBeGreaterThanOrEqual(400);
      await expectNoLocalCredential();
      assertNoProviderReadsOrMembershipWrites();
      expect(JSON.stringify(logs.error.mock.calls)).not.toContain(SECRET);

      const after = await evidence();
      observations.push({ sql: 'FINAL DURABLE STATE', providerCalled: provider.createUser.mock.calls.length > 0, evidence: after });
      expectConsistentVisibleState();

      if (phase === 'creating') {
        expect(provider.createUser).not.toHaveBeenCalled();
        expect(provider.deleteUser).not.toHaveBeenCalled();
        // A pre-COMMIT rollback can remove admission entirely. A genuinely
        // uncertain COMMIT may instead reserve an audited blocking operation.
        if (after.length === 0) return;
        expect(after).toHaveLength(1);
        expect(after[0].operation.status).toBe('reconciliation_required');
      } else {
        expect(provider.createUser).toHaveBeenCalledTimes(1);
        expect(after).toHaveLength(1);
      }

      const op = after[0].operation;
      if (phase === 'committed' && result.body.compensated === true) {
        // A detected audit fault before COMMIT plus acknowledged rollback may
        // legitimately compensate. Do not mistake that safe outcome for failure.
        expect(op.status).toBe('compensated');
        expect(provider.deleteUser).toHaveBeenCalledTimes(1);
        expect(after[0].audits.filter(row => exactMarker(row, op, false))).toHaveLength(1);
        expect(after[0].audits.filter(row => exactMarker(row, op, true))).toHaveLength(1);
        const replay = await createAndBindAdminCredential(input());
      expect(replay.body).toMatchObject({ reconciliation_required: true, operation_id: op.id });
      expect(provider.createUser).toHaveBeenCalledTimes(1);
      expect(provider.deleteUser).toHaveBeenCalledTimes(1);
      return;
      }

      expect(result.body.compensated).not.toBe(true);
      expect(result.body.reconciliation_required).toBe(true);
      expect(['committed', 'compensated', 'provider_rejected']).not.toContain(op.status);
      if (phase === 'reconciliation_required') {
        // Every failed reconciliation write must preserve the original operation
        // verbatim, including its provider ID, failure code and timestamps.
        expect(after).toEqual(beforeProvider);
        expect(op.status).toBe('creating');
      }
      if (phase === 'compensated' || phase === 'confirmed_marker') {
        expect(provider.deleteUser).toHaveBeenCalledTimes(1);
        expect(after[0].audits.filter(row => exactMarker(row, op, false))).toHaveLength(1);
        expect(after[0].audits.filter(row => row.action === confirmedAction)).toEqual([]);
      } else if (phase !== 'committed') {
        expect(provider.deleteUser).not.toHaveBeenCalled();
      }

      const creates = provider.createUser.mock.calls.length;
      const deletes = provider.deleteUser.mock.calls.length;
      const replay = await createAndBindAdminCredential(input());
      expect(replay.body).toMatchObject({ reconciliation_required: true, operation_id: op.id });
      expect(replay.body.bound).not.toBe(true);
      expect(replay.body.compensated).not.toBe(true);
      expect(provider.createUser).toHaveBeenCalledTimes(creates);
      expect(provider.deleteUser).toHaveBeenCalledTimes(deletes);
      expect(await evidence()).toEqual(after);
    }

    it.each(phases.flatMap(phase => faults.map(fault => ({ phase, fault }))))(
      'keeps $phase truthful and atomic with a $fault audit trigger',
      async ({ phase, fault }) => {
        await installAuditFault(phase, fault);
        await arrange(phase);
        const result = await createAndBindAdminCredential(input(), { pool: observedPool() });
        await expectFailureOutcome(phase, result);
      },
    );

    it.each([
      { later: 'compensating', earlier: quarantineAction, mutation: 'delete', deferred: false },
      { later: 'compensating', earlier: quarantineAction, mutation: 'delete', deferred: true },
      { later: 'compensated', earlier: confirmedAction, mutation: 'alter', deferred: false },
      { later: 'compensated', earlier: confirmedAction, mutation: 'alter', deferred: true },
    ] as const)(
      'rechecks the earlier $earlier receipt after the later $later audit (deferred=$deferred)',
      async ({ later, earlier, mutation, deferred }) => {
        // The earlier helper has already returned a valid INSERT receipt. Only a
        // final transaction-boundary recheck detects this later trigger damage.
        const damage = mutation === 'delete'
          ? 'DELETE FROM registry_audit_log WHERE resource_id = NEW.resource_id AND action = ' + literal(earlier) + ';'
          : 'UPDATE registry_audit_log SET details = jsonb_set(details,'
            + " '{deletion_source}', to_jsonb('not_admin_compensation'::text))"
            + ' WHERE resource_id = NEW.resource_id AND action = ' + literal(earlier) + ';';
        await pool.query(
          'CREATE FUNCTION ' + faultName + '() RETURNS trigger LANGUAGE plpgsql AS $$'
          + ' BEGIN IF ' + phasePredicate(later) + ' THEN ' + damage + ' END IF; RETURN NEW; END; $$',
        );
        await pool.query(
          'CREATE ' + (deferred ? 'CONSTRAINT ' : '') + 'TRIGGER ' + faultName
          + ' AFTER INSERT ON registry_audit_log'
          + (deferred ? ' DEFERRABLE INITIALLY DEFERRED' : '')
          + ' FOR EACH ROW EXECUTE FUNCTION ' + faultName + '()',
        );
        await arrange(later);
        const result = await createAndBindAdminCredential(input(), { pool: observedPool() });
        await expectFailureOutcome(later, result);
      },
    );
    type OwnedPhase = 'provider_created' | 'provider_rejected' | 'reconciliation_required' | 'compensating' | 'compensated';
    type CommitFault = 'reply_lost' | 'actual_rollback' | 'wrong_command' | 'before_send';

    function ownedCommitFaultPool(phase: OwnedPhase, fault: CommitFault) {
      let transactionPhase: string | undefined;
      let injected = false;
      let recoveryAuditAttempts = 0;
      let stateAtFault: Awaited<ReturnType<typeof evidence>> | undefined;

      const transport = intentFaultPool(async (query, sql, params) => {
        if (sql.trim() === 'BEGIN') transactionPhase = undefined;
        if (sql.includes('UPDATE admin_credential_bind_operations')) {
          transactionPhase = typeof params?.[1] === 'string' ? params[1] : undefined;
        }
        if (transactionPhase === 'reconciliation_required'
          && sql.includes('INSERT INTO registry_audit_log')) recoveryAuditAttempts++;

        if (!injected && transactionPhase === phase && sql.trim() === 'COMMIT') {
          injected = true;
          if (fault === 'before_send') {
            stateAtFault = await evidence();
            throw new Error(SECRET);
          }
          const receipt = await query(fault === 'actual_rollback' ? 'ROLLBACK' : 'COMMIT');
          stateAtFault = await evidence(); // Separate session sees the real durable outcome.
          if (fault === 'reply_lost') throw new Error(SECRET);
          if (fault === 'wrong_command') return { ...receipt, command: 'UNKNOWN' };
          return receipt; // Actual ROLLBACK receipt must not be accepted as COMMIT.
        }
        return query(sql, params);
      });
      return {
        ...transport,
        wasInjected: () => injected,
        recoveryAttempts: () => recoveryAuditAttempts,
        stateAtFault: () => stateAtFault,
      };
    }

    it.each([
      { phase: 'provider_rejected', fault: 'reply_lost' },
      { phase: 'provider_rejected', fault: 'actual_rollback' },
      { phase: 'compensated', fault: 'reply_lost' },
      { phase: 'compensated', fault: 'actual_rollback' },
    ] as const)(
      'never reopens a $phase terminal attempt after $fault plus both reconciliation writes failing',
      async ({ phase, fault }) => {
        // This is a REAL DB evidence outage. Both recovery UPDATEs must roll back
        // when their mandatory audit insert is suppressed, preserving exact state.
        await installAuditFault('reconciliation_required', 'before_null');
        await arrange(phase);
        const transport = ownedCommitFaultPool(phase, fault);
        const result = await createAndBindAdminCredential(input(), { pool: transport.pool });

        expect(transport.wasInjected()).toBe(true);
        expect(transport.recoveryAttempts()).toBe(2);
        expect(result.status).toBe(503);
        expect(result.body.reconciliation_required).toBe(true);
        expect(result.body.bound).not.toBe(true);
        expect(result.body.compensated).not.toBe(true);
        const after = await evidence();
        expect(after).toEqual(transport.stateAtFault());
        expect(after).toHaveLength(1);
        const operation = after[0].operation;
        expect(operation.status).toBe(fault === 'reply_lost'
          ? phase
          : phase === 'compensated' ? 'compensating' : 'creating');
        expect(after[0].audits.filter(row => exactOperationAudit(row, operation))).toHaveLength(1);
        if (phase === 'compensated') {
          expect(after[0].audits.filter(row => exactMarker(row, operation, false))).toHaveLength(1);
          expect(after[0].audits.filter(row => exactMarker(row, operation, true)))
            .toHaveLength(fault === 'reply_lost' ? 1 : 0);
        }
        await expectNoLocalCredential();
        expect(provider.createUser).toHaveBeenCalledTimes(1);
        expect(provider.deleteUser).toHaveBeenCalledTimes(phase === 'compensated' ? 1 : 0);

        // A terminal row still records an attempted provider operation. Excluding
        // it from admission would silently open a new create after this lost reply.
        for (const hostUserId of [HOST, OTHER_HOST]) {
          const replay = await createAndBindAdminCredential(input({ hostUserId }));
          expect(replay.status).toBe(503);
          expect(replay.body).toMatchObject({
            reconciliation_required: true, operation_id: operation.id,
          });
          expect(replay.body.bound).not.toBe(true);
          expect(replay.body.compensated).not.toBe(true);
        }
        expect(await evidence()).toEqual(after);
        expect(provider.createUser).toHaveBeenCalledTimes(1);
        expect(provider.deleteUser).toHaveBeenCalledTimes(phase === 'compensated' ? 1 : 0);
        assertNoProviderReadsOrMembershipWrites();
        expect(JSON.stringify(logs.error.mock.calls)).not.toContain(SECRET);
      },
    );

    it.each([
      'provider_created', 'provider_rejected', 'reconciliation_required',
    ] as const)(
      'reconciles $phase after an acknowledged-on-server COMMIT reply is lost without repeating WorkOS',
      async (phase) => {
        await arrange(phase);
        const transport = ownedCommitFaultPool(phase, 'reply_lost');
        const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
        expect(transport.wasInjected()).toBe(true);
        expect(result.status).toBe(503);
        expect(result.body.reconciliation_required).toBe(true);
        expect(result.body.bound).not.toBe(true);
        expect(result.body.compensated).not.toBe(true);
        const [after] = await evidence();
        expect(after.operation.status).toBe('reconciliation_required');
        expect(after.audits.filter(row => exactOperationAudit(row, after.operation))).toHaveLength(1);
        if (phase === 'reconciliation_required') {
          const versions = after.audits.filter(row => row.action === 'admin_credential_bind'
            && row.details.status === 'reconciliation_required').map(row => row.details.operation_version);
          // Both real committed reconciliation events survive, with distinct
          // tuple versions. Only one describes the operation's current version.
          expect(versions).toHaveLength(2);
          expect(new Set(versions).size).toBe(2);
        }
        await expectNoLocalCredential();
        expect(provider.createUser).toHaveBeenCalledTimes(1);
        expect(provider.deleteUser).not.toHaveBeenCalled();
        const replay = await createAndBindAdminCredential(input());
        expect(replay.body).toMatchObject({ reconciliation_required: true, operation_id: after.operation.id });
        expect(provider.createUser).toHaveBeenCalledTimes(1);
        assertNoProviderReadsOrMembershipWrites();
      },
    );

    it.each(['before_send', 'actual_rollback', 'wrong_command'] as const)(
      'refuses provider-created admission after owned COMMIT $fault', async (fault) => {
        await arrange('provider_created');
        const transport = ownedCommitFaultPool('provider_created', fault);
        const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
        expect(transport.wasInjected()).toBe(true);
        await expectFailureOutcome('provider_created', result);
      },
    );

    type ReceiptFault = 'zero_count' | 'null_count' | 'multiple_count'
      | 'missing_rows' | 'duplicate_rows' | 'missing_version' | 'same_version';
    it.each([
      'zero_count', 'null_count', 'multiple_count', 'missing_rows',
      'duplicate_rows', 'missing_version', 'same_version',
    ] as ReceiptFault[])(
      'rejects an owned provider-created UPDATE receipt with $fault', async (fault) => {
        let injected = false;
        await arrange('provider_created');
        const transport = intentFaultPool(async (query, sql, params) => {
          const receipt = await query(sql, params);
          if (injected || !sql.includes('UPDATE admin_credential_bind_operations')
            || params?.[1] !== 'provider_created') return receipt;
          injected = true;
          if (fault === 'zero_count') return { ...receipt, rowCount: 0 };
          if (fault === 'null_count') return { ...receipt, rowCount: null };
          if (fault === 'multiple_count') return { ...receipt, rowCount: 2 };
          if (fault === 'missing_rows') return { ...receipt, rows: [] };
          if (fault === 'duplicate_rows') return { ...receipt, rows: [...receipt.rows, ...receipt.rows] };
          return { ...receipt, rows: [{ ...receipt.rows[0],
            receipt_version: fault === 'missing_version' ? undefined : params[5] }] };
        });
        const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
        expect(injected).toBe(true);
        await expectFailureOutcome('provider_created', result);
      },
    );

    it.each(['reply_lost', 'wrong_command'] as const)(
      'discards the client when an owned transition ROLLBACK has $fault', async (fault) => {
        let receiptFault = false;
        let rollbackFault = false;
        await arrange('provider_created');
        const transport = intentFaultPool(async (query, sql, params) => {
          const receipt = await query(sql, params);
          if (!receiptFault && sql.includes('UPDATE admin_credential_bind_operations')
            && params?.[1] === 'provider_created') {
            receiptFault = true;
            return { ...receipt, rowCount: 0 };
          }
          if (receiptFault && !rollbackFault && sql.trim() === 'ROLLBACK') {
            rollbackFault = true;
            if (fault === 'reply_lost') throw new Error(SECRET);
            return { ...receipt, command: 'UNKNOWN' };
          }
          return receipt;
        });
        const result = await createAndBindAdminCredential(input(), { pool: transport.pool });
        expect(receiptFault).toBe(true);
        expect(rollbackFault).toBe(true);
        expect(transport.releases).toContain(true);
        await expectFailureOutcome('provider_created', result);
      },
    );

    it.each([
      ...(['creating', 'provider_rejected', 'provider_created', 'reconciliation_required', 'committed', 'compensating', 'compensated'] as const)
        .flatMap(phase => [false, true].map(deferred => ({ phase, deferred }))),
      { phase: 'quarantine_marker', deferred: false },
      { phase: 'quarantine_marker', deferred: true },
      { phase: 'confirmed_marker', deferred: false },
      { phase: 'confirmed_marker', deferred: true },
    ] as const)(
      'rejects an extra $phase clone even when it injects operation_version (deferred=$deferred)',
      async ({ phase, deferred }) => {
        await pool.query(
          'CREATE FUNCTION ' + faultName + '() RETURNS trigger LANGUAGE plpgsql AS $$'
          + " BEGIN IF NEW.details->>'operation_version' IS DISTINCT FROM 'injected' AND " + phasePredicate(phase) + ' THEN'
          + ' INSERT INTO registry_audit_log'
          + ' (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)'
          + ' VALUES (NEW.workos_organization_id, NEW.workos_user_id, NEW.action,'
          + ' NEW.resource_type, NEW.resource_id,'
          + " NEW.details || jsonb_build_object('operation_version', 'injected'));"
          + ' END IF; RETURN NEW; END; $$',
        );
        await pool.query(
          'CREATE ' + (deferred ? 'CONSTRAINT ' : '') + 'TRIGGER ' + faultName
          + ' AFTER INSERT ON registry_audit_log'
          + (deferred ? ' DEFERRABLE INITIALLY DEFERRED' : '')
          + ' FOR EACH ROW EXECUTE FUNCTION ' + faultName + '()',
        );
        await arrange(phase);
        const result = await createAndBindAdminCredential(input(), { pool: observedPool() });
        await expectFailureOutcome(phase, result);
      },
    );

    // Retain the whole receipt cohort after a real COMMIT with a lost reply.
    it.each([
      { phase: 'compensating', marker: quarantineAction, expectedDeletes: 0 },
      { phase: 'compensated', marker: confirmedAction, expectedDeletes: 1 },
    ] as const)(
      'preserves a committed $marker after a lost COMMIT and both reconciliation writes attack it',
      async ({ phase, marker, expectedDeletes }) => {
        await pool.query(
          'CREATE FUNCTION ' + faultName + '() RETURNS trigger LANGUAGE plpgsql AS $$'
          + ' BEGIN IF ' + phasePredicate('reconciliation_required') + ' THEN'
          + ' DELETE FROM registry_audit_log WHERE resource_id = NEW.resource_id'
          + ' AND action = ' + literal(marker) + '; END IF; RETURN NEW; END; $$',
        );
        await pool.query(
          'CREATE TRIGGER ' + faultName + ' AFTER INSERT ON registry_audit_log'
          + ' FOR EACH ROW EXECUTE FUNCTION ' + faultName + '()',
        );
        await arrange(phase);
        const transport = ownedCommitFaultPool(phase, 'reply_lost');
        const result = await createAndBindAdminCredential(input(), { pool: transport.pool });

        expect(transport.wasInjected()).toBe(true);
        expect(transport.recoveryAttempts()).toBe(2);
        expect(result.status).toBe(503);
        expect(result.body.reconciliation_required).toBe(true);
        expect(result.body.compensated).not.toBe(true);
        expect(result.body.bound).not.toBe(true);
        const after = await evidence();
        expect(after).toEqual(transport.stateAtFault());
        expect(after).toHaveLength(1);
        const operation = after[0].operation;
        expect(operation.status).toBe(phase);
        expect(after[0].audits.filter(row => exactOperationAudit(row, operation))).toHaveLength(1);
        expect(after[0].audits.filter(row => exactMarker(row, operation, false))).toHaveLength(1);
        expect(after[0].audits.filter(row => exactMarker(row, operation, true)))
          .toHaveLength(phase === 'compensated' ? 1 : 0);
        await expectNoLocalCredential();

        const replay = await createAndBindAdminCredential(input());
        expect(replay.body).toMatchObject({
          reconciliation_required: true, operation_id: operation.id,
        });
        expect(replay.body.compensated).not.toBe(true);
        expect(await evidence()).toEqual(after);
        expect(provider.createUser).toHaveBeenCalledTimes(1);
        expect(provider.deleteUser).toHaveBeenCalledTimes(expectedDeletes);
        assertNoProviderReadsOrMembershipWrites();
        expect(JSON.stringify(logs.error.mock.calls)).not.toContain(SECRET);
      },
    );

    /**
     * Distinct authorized credential, SAME identity: the saga may return read-only
     * reconciliation, but must not rewrite the original actor's operation or audit.
     * The real route-authorization fixtures remain unchanged.
     */
    it.each([
      { invalidated: false, failedUnlock: false },
      { invalidated: false, failedUnlock: true },
      { invalidated: true, failedUnlock: false },
      { invalidated: true, failedUnlock: true },
    ])(
      'keeps cross-actor replay read-only (invalidated=$invalidated, failedUnlock=$failedUnlock)',
      async ({ invalidated, failedUnlock }) => {
        const created = await createAndBindAdminCredential(input());
        expect(created.status).toBe(201);
        if (invalidated) {
          // A missing credential is a real terminal local lifecycle observation.
          // Remove only this fresh fixture row; FK cascades remove its binding/epoch.
          await pool.query('DELETE FROM users WHERE workos_user_id = $1', [CREATED]);
        }
        const before = await evidence();
        expect(before).toHaveLength(1);
        const transport = failedUnlock ? faultPool('unlock_false') : undefined;
        const replay = await createAndBindAdminCredential(
          input({ actorUserId: ACTOR_PRIMARY, actorIdentityId }),
          transport ? { pool: transport.pool } : {},
        );
        expect(replay.status).toBe(503);
        expect(replay.body.reconciliation_required).toBe(true);
        expect(replay.body.bound).not.toBe(true);
        expect(replay.body.compensated).not.toBe(true);
        expect(await evidence()).toEqual(before);
        expect(provider.createUser).toHaveBeenCalledTimes(1);
        expect(provider.deleteUser).not.toHaveBeenCalled();
        assertNoProviderReadsOrMembershipWrites();
        if (transport) {
          expect(transport.wasInjected()).toBe(true);
          expect(transport.releases).toContain(true);
        }
      },
    );

  });
});
