/**
 * The admin saga and authoritative WorkOS deletion share one PostgreSQL
 * credential lifecycle fence. These tests keep database transactions real and
 * control provider replies / individual SQL replies at explicit boundaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';

const provider = vi.hoisted(() => ({ createUser: vi.fn(), deleteUser: vi.fn() }));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/auth/workos-client.js', () => ({
  getAdminCredentialMutationWorkos: () => ({ userManagement: provider }),
}));
vi.mock('../../src/logger.js', () => ({ createLogger: () => logs }));
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { deleteIdentityCredentialTransaction, withCredentialCreationEventMutation } from '../../src/db/identity-db.js';
import { getAuthorizationFingerprint, readCredentialAuthorizationLifecycle } from '../../src/db/authorization-epoch-db.js';
import { createAndBindAdminCredential } from '../../src/services/admin-credential-bind.js';

const PREFIX = 'user_admin_bind_lifecycle_';
const HOST = `${PREFIX}sam`;
const HOST_SIBLING = `${PREFIX}sam_existing`;
const ACTOR_PRIMARY = `${PREFIX}jordan`;
const ACTOR = `${PREFIX}jordan_credential`;
const CREATED = `${PREFIX}sam_new`;
const EMAIL = 'sam.new@admin-bind-lifecycle.example';
const SECRET = 'provider-response-token-must-not-be-recorded';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

type RawQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>;
interface QueryHooks {
  before?: (sql: string, params: unknown[] | undefined, query: RawQuery) => Promise<void>;
  after?: (sql: string, params: unknown[] | undefined, result: QueryResult) => Promise<QueryResult | void>;
}

describe('admin credential binding and terminal lifecycle', () => {
  let pool: Pool;
  let actorIdentityId: string;
  let hostIdentityId: string;
  const identityIds = new Set<string>();

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
    provider.createUser.mockReset().mockResolvedValue(createdUser());
    provider.deleteUser.mockReset().mockResolvedValue(undefined);
    await insertUser(HOST, 'sam@admin-bind-lifecycle.example', 'Sam', 'Adeyemi');
    await insertUser(HOST_SIBLING, 'sam.existing@admin-bind-lifecycle.example', 'Sam', 'Adeyemi');
    await insertUser(ACTOR_PRIMARY, 'jordan@admin-bind-lifecycle.example', 'Jordan', 'Ochoa');
    await insertUser(ACTOR, 'jordan.credential@admin-bind-lifecycle.example', 'Jordan', 'Ochoa');
    actorIdentityId = await identityOf(ACTOR_PRIMARY);
    hostIdentityId = await identityOf(HOST);
    for (const [identityId, userId] of [[actorIdentityId, ACTOR], [hostIdentityId, HOST_SIBLING]]) {
      await pool.query(
        'UPDATE identity_workos_users SET identity_id = $1, is_primary = false WHERE workos_user_id = $2',
        [identityId, userId],
      );
    }
  });

  function input() { return { hostUserId: HOST, email: EMAIL, actorUserId: ACTOR, actorIdentityId }; }
  function createdUser() {
    return {
      id: CREATED, email: EMAIL, firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true,
      createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    };
  }
  async function identityOf(userId: string) {
    const binding = (await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1', [userId],
    )).rows[0];
    if (!binding) throw new Error('Expected fixture credential binding');
    return binding.identity_id;
  }
  async function insertUser(id: string, email: string, firstName: string, lastName: string) {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
       workos_created_at, workos_updated_at) VALUES ($1, $2, $3, $4, true, NOW(), NOW())`,
      [id, email, firstName, lastName],
    );
    identityIds.add(await identityOf(id));
  }
  async function cleanup() {
    const identities = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE starts_with(workos_user_id, $1)', [PREFIX],
    );
    identities.rows.forEach((row) => identityIds.add(row.identity_id));
    await pool.query(
      `DELETE FROM registry_audit_log WHERE starts_with(workos_user_id, $1)
       OR (action = 'admin_credential_bind' AND details->>'host_user_id' = $2)`, [PREFIX, HOST],
    );
    await pool.query('DELETE FROM admin_credential_bind_operations WHERE host_user_id = $1', [HOST]);
    await pool.query('DELETE FROM users WHERE starts_with(workos_user_id, $1)', [PREFIX]);
    if (identityIds.size) await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [[...identityIds]]);
    identityIds.clear();
  }
  async function operations() {
    return (await pool.query(
      `SELECT id, status, provider_user_id, failure_code FROM admin_credential_bind_operations
       WHERE host_user_id = $1 ORDER BY created_at, id`, [HOST],
    )).rows;
  }
  async function addTerminalMarker(userId: string, action = 'identity_credential_deleted') {
    await pool.query(
      `INSERT INTO registry_audit_log
       (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
       VALUES ('system', $1::text, $2::text, 'identity_credential', $1::text, '{}'::jsonb)`, [userId, action],
    );
  }
  async function expectNoCreatedArtifacts(observedIdentities: Set<string> = new Set()) {
    for (const table of ['users', 'identity_workos_users', 'authorization_epochs']) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE workos_user_id = $1`, [CREATED])).rows).toEqual([]);
    }
    if (observedIdentities.size) {
      expect((await pool.query('SELECT 1 FROM identities WHERE id = ANY($1::uuid[])', [[...observedIdentities]])).rows).toEqual([]);
    }
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log WHERE action = 'admin_credential_bind'
       AND details->>'host_user_id' = $1 AND details->>'status' = 'committed'`, [HOST],
    )).rows).toEqual([]);
  }
  async function expectBlockedReplay(operationId: string) {
    const replay = await createAndBindAdminCredential(input());
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.body).toMatchObject({ reconciliation_required: true, operation_id: operationId });
    expect(provider.createUser).toHaveBeenCalledTimes(1);
  }
  function delayedCreationCallback() {
    return vi.fn(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
         workos_created_at, workos_updated_at) VALUES ($1, $2, 'Sam', 'Adeyemi', true, NOW(), NOW())`,
        [CREATED, EMAIL],
      );
    });
  }
  async function expectDelayedCreationBlocked() {
    const callback = delayedCreationCallback();
    expect(await withCredentialCreationEventMutation(CREATED, callback)).toEqual({ applied: false });
    expect(callback).not.toHaveBeenCalled();
  }
  async function expectOwnCompensationQuarantine(operationId: string) {
    const quarantine = await pool.query<{ resource_type: string; resource_id: string; details: Record<string, unknown> }>(
      `SELECT resource_type, resource_id, details FROM registry_audit_log WHERE workos_user_id = $1
       AND action = 'identity_credential_admin_compensation_quarantined'`, [CREATED],
    );
    expect(quarantine.rows).toHaveLength(1);
    expect(quarantine.rows[0]).toMatchObject({ resource_type: 'admin_credential_bind_operation', resource_id: operationId });
    expect(quarantine.rows[0].details).toMatchObject({
      operation_id: operationId, provider_user_id: CREATED,
      acting_workos_user_id: ACTOR, actor_identity_id: actorIdentityId,
      quarantine_reason: 'admin_credential_compensation_pending', provider_delete_confirmed: false,
    });
  }

  function observedPool(hooks: QueryHooks = {}) {
    let pid: number | undefined;
    const createdIdentities = new Set<string>();
    const statements: string[] = [];
    const proxy = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect') return async () => {
          const client = await target.connect();
          const query: RawQuery = client.query.bind(client);
          const release = client.release.bind(client);
          pid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          client.query = (async (sql: string, params?: unknown[]) => {
            statements.push(sql);
            await hooks.before?.(sql, params, query);
            const result = await query(sql, params);
            if (sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
              const identity = await query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1', [CREATED]);
              if (identity.rows[0]) {
                createdIdentities.add(identity.rows[0].identity_id);
                identityIds.add(identity.rows[0].identity_id);
              }
            }
            return (await hooks.after?.(sql, params, result)) ?? result;
          }) as PoolClient['query'];
          client.release = (error?: boolean | Error) => {
            client.query = query as PoolClient['query'];
            client.release = release;
            release(error);
          };
          return client;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { pool: proxy, createdIdentities, statements, pid: () => pid };
  }

  it('refuses recreation when deletion of the unseen ID commits before the provider create reply', async () => {
    provider.createUser.mockImplementationOnce(async () => {
      expect((await deleteIdentityCredentialTransaction(CREATED, 'workos_webhook')).deleted).toBe(false);
      expect(await readCredentialAuthorizationLifecycle(CREATED)).toEqual({ status: 'terminal', reason: 'deleted_or_quarantined' });
      return createdUser();
    });
    const observed = observedPool();

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.reconciliation_required).toBe(true);
    const [operation] = await operations();
    expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
    expect(observed.statements.some((sql) => sql.includes('INSERT INTO users'))).toBe(false);
    await expectNoCreatedArtifacts(observed.createdIdentities);
    await expectBlockedReplay(operation.id);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it('refuses a binding when the host is quarantined by primary deletion during provider creation', async () => {
    provider.createUser.mockImplementationOnce(async () => {
      const deletion = await deleteIdentityCredentialTransaction(HOST, 'workos_webhook');
      expect(deletion.quarantine).not.toBeNull();
      return createdUser();
    });

    const result = await createAndBindAdminCredential(input());

    expect(result.body.reconciliation_required).toBe(true);
    expect(await readCredentialAuthorizationLifecycle(HOST)).toEqual({ status: 'terminal', reason: 'deleted_or_quarantined' });
    await expectNoCreatedArtifacts();
    const [operation] = await operations();
    expect(operation.status).toBe('reconciliation_required');
    await expectBlockedReplay(operation.id);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    expect(await identityOf(HOST_SIBLING)).toBe(hostIdentityId);
  });

  it('requires reconciliation when the authenticated actor loses its primary during provider creation', async () => {
    provider.createUser.mockImplementationOnce(async () => {
      await deleteIdentityCredentialTransaction(ACTOR_PRIMARY, 'workos_webhook');
      return createdUser();
    });

    const result = await createAndBindAdminCredential(input());

    expect(await readCredentialAuthorizationLifecycle(ACTOR)).toEqual({ status: 'terminal', reason: 'missing_primary' });
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1
       AND action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')`, [ACTOR],
    )).rows).toEqual([]);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.reconciliation_required).toBe(true);
    await expectNoCreatedArtifacts();
    const [operation] = await operations();
    expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
    await expectBlockedReplay(operation.id);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it('blocks a quarantined new credential even when no local user or binding exists', async () => {
    provider.createUser.mockImplementationOnce(async () => {
      await addTerminalMarker(CREATED, 'identity_primary_deletion_quarantined');
      return createdUser();
    });

    const result = await createAndBindAdminCredential(input());

    expect(result.body.reconciliation_required).toBe(true);
    expect(await readCredentialAuthorizationLifecycle(CREATED)).toEqual({ status: 'terminal', reason: 'deleted_or_quarantined' });
    await expectNoCreatedArtifacts();
    await expectBlockedReplay((await operations())[0].id);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it.each([HOST, ACTOR])('rejects a terminal marker on %s that appears during provider creation', async (userId) => {
    provider.createUser.mockImplementationOnce(async () => {
      await addTerminalMarker(userId);
      return createdUser();
    });

    const result = await createAndBindAdminCredential(input());

    expect(result.body.reconciliation_required).toBe(true);
    expect(await readCredentialAuthorizationLifecycle(userId)).toEqual({ status: 'terminal', reason: 'deleted_or_quarantined' });
    await expectNoCreatedArtifacts();
    await expectBlockedReplay((await operations())[0].id);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it('keeps a successful replay on the same operation without provider calls or additional epoch bumps', async () => {
    const first = await createAndBindAdminCredential(input());
    expect(first.status).toBe(201);
    const fingerprint = await getAuthorizationFingerprint([HOST, HOST_SIBLING, CREATED]);

    const replay = await createAndBindAdminCredential(input());

    expect(replay.status).toBe(200);
    expect(replay.body.operation_id).toBe(first.body.operation_id);
    expect(await operations()).toHaveLength(1);
    expect(await getAuthorizationFingerprint([HOST, HOST_SIBLING, CREATED])).toBe(fingerprint);
    expect(provider.createUser).toHaveBeenCalledTimes(1);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    [CREATED, 'identity_credential_deleted'],
    [CREATED, 'identity_primary_deletion_quarantined'],
    [HOST, 'identity_credential_deleted'],
    [ACTOR, 'identity_credential_deleted'],
  ])('refuses committed replay when %s has marker %s despite intact local rows', async (userId, action) => {
    const first = await createAndBindAdminCredential(input());
    expect(first.status).toBe(201);
    await addTerminalMarker(userId, action);
    expect(await identityOf(CREATED)).toBe(hostIdentityId);
    const fingerprint = await getAuthorizationFingerprint([HOST, HOST_SIBLING, CREATED]);

    await expectBlockedReplay(String(first.body.operation_id));

    expect(await getAuthorizationFingerprint([HOST, HOST_SIBLING, CREATED])).toBe(fingerprint);
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it('serializes deletion behind a binding commit and removes the credential on provider redelivery', async () => {
    const atCommit = deferred<void>();
    const releaseCommit = deferred<void>();
    let inserted = false;
    let paused = false;
    const observed = observedPool({
      before: async (sql) => {
        if (inserted && !paused && sql.trim() === 'COMMIT') {
          paused = true;
          atCommit.resolve();
          await releaseCommit.promise;
        }
      },
      after: async (sql) => { if (sql.includes('INSERT INTO users')) inserted = true; },
    });
    const binding = createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });
    await atCommit.promise;
    const deletion = deleteIdentityCredentialTransaction(CREATED, 'workos_webhook')
      .then((value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
    try {
      await expect.poll(async () => (await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks waiting JOIN pg_locks holder
             ON waiting.locktype = holder.locktype AND waiting.database = holder.database
            AND waiting.classid = holder.classid AND waiting.objid = holder.objid
            AND waiting.objsubid = holder.objsubid
          WHERE waiting.locktype = 'advisory' AND NOT waiting.granted AND holder.granted
            AND holder.pid = $1
            AND holder.classid = ((hashtextextended($2, 6827) >> 32) & 4294967295)::oid
            AND holder.objid = (hashtextextended($2, 6827) & 4294967295)::oid
        ) AS blocked`, [observed.pid(), CREATED],
      )).rows[0].blocked, { timeout: 750, interval: 10 }).toBe(true);
    } finally {
      releaseCommit.resolve();
    }
    const result = await binding;
    expect(result.status).toBe(201);
    const firstDeletion = await deletion;
    // Discovery preceded the uncommitted INSERT. The existing deletion helper
    // rejects its stale topology snapshot; WorkOS redelivery then sees it.
    expect(firstDeletion.error?.message).toBe('Credential identity changed while acquiring deletion locks');
    expect((await deleteIdentityCredentialTransaction(CREATED, 'workos_webhook')).deleted).toBe(true);
    expect(await readCredentialAuthorizationLifecycle(CREATED)).toEqual({ status: 'terminal', reason: 'deleted_or_quarantined' });
    for (const table of ['users', 'identity_workos_users', 'authorization_epochs']) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE workos_user_id = $1`, [CREATED])).rows).toEqual([]);
    }
    expect((await pool.query('SELECT 1 FROM identities WHERE id = ANY($1::uuid[])', [[...observed.createdIdentities]])).rows).toEqual([]);
    await expectBlockedReplay(String(result.body.operation_id));
    expect(provider.deleteUser).not.toHaveBeenCalled();
  });

  it.each(['lock_query', 'lock_cardinality', 'snapshot_query', 'snapshot_cardinality'] as const)(
    'requires reconciliation without deletion when the lifecycle fence fails (%s)', async (fault) => {
      let injected = false;
      const observed = observedPool({
        before: async (sql) => {
          if (!injected && ((fault === 'lock_query' && sql.includes('pg_advisory_xact_lock'))
            || (fault === 'snapshot_query' && sql.includes('terminal_marker') && sql.includes('requested.workos_user_id')))) {
            injected = true;
            throw new Error(SECRET);
          }
        },
        after: async (sql, _params, result) => {
          if (!injected && ((fault === 'lock_cardinality' && sql.includes('pg_advisory_xact_lock'))
            || (fault === 'snapshot_cardinality' && sql.includes('terminal_marker') && sql.includes('requested.workos_user_id')))) {
            injected = true;
            return { ...result, rows: [], rowCount: 0 };
          }
        },
      });

      const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

      expect(injected).toBe(true);
      expect(result.body.reconciliation_required).toBe(true);
      const [operation] = await operations();
      expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
      expect(operation.failure_code).toBeTruthy();
      await expectNoCreatedArtifacts(observed.createdIdentities);
      await expectBlockedReplay(operation.id);
      expect(provider.deleteUser).not.toHaveBeenCalled();
      expect(JSON.stringify({ result, operation, logs: Object.values(logs).map((log) => log.mock.calls) })).not.toContain(SECRET);
    },
  );

  it('rolls back the complete binding if the success audit reports the wrong cardinality', async () => {
    let injected = false;
    const observed = observedPool({
      after: async (sql, params, result) => {
        if (!injected && sql.includes('UPDATE admin_credential_bind_operations') && params?.[1] === 'committed') {
          injected = true;
          return { ...result, rowCount: 0 };
        }
      },
    });

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(injected).toBe(true);
    expect(result.body.compensated).toBe(true);
    expect(observed.createdIdentities.size).toBe(1);
    await expectNoCreatedArtifacts(observed.createdIdentities);
    expect((await operations())[0].status).toBe('compensated');
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    expect(await getAuthorizationFingerprint([HOST, HOST_SIBLING])).toBe('');
  });

  it('rolls back every binding and epoch when the bump receipt omits the new credential', async () => {
    let injected = false;
    const observed = observedPool({
      after: async (sql, _params, result) => {
        if (!injected && sql.includes('INSERT INTO authorization_epochs')) {
          injected = true;
          const rows = result.rows.filter((row) => row.workos_user_id !== CREATED);
          return { ...result, rows, rowCount: rows.length };
        }
      },
    });

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(injected).toBe(true);
    expect(result.body.compensated).toBe(true);
    expect(observed.createdIdentities.size).toBe(1);
    await expectNoCreatedArtifacts(observed.createdIdentities);
    expect(await getAuthorizationFingerprint([HOST, HOST_SIBLING])).toBe('');
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
  });

  it.each(['deletion', 'local_user'] as const)(
    'does not compensate a provider credential whose lifecycle changed after local rollback (%s)', async (change) => {
      let failed = false;
      let changed = false;
      let racedIdentity: string | undefined;
      const observed = observedPool({
        before: async (sql, params, query) => {
          if (!failed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
            failed = true;
            // Abort the real local transaction, then let the independent
            // deletion/upsert commit before the compensation fence is read.
            await query('SELECT 1 / 0');
          }
        },
        after: async (sql) => {
          if (failed && !changed && sql.trim() === 'ROLLBACK') {
            changed = true;
            if (change === 'deletion') await deleteIdentityCredentialTransaction(CREATED, 'workos_webhook');
            else {
              await insertUser(CREATED, EMAIL, 'Sam', 'Adeyemi');
              racedIdentity = await identityOf(CREATED);
            }
          }
        },
      });

      const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

      expect(failed && changed).toBe(true);
      expect(result.body.reconciliation_required).toBe(true);
      expect(provider.deleteUser).not.toHaveBeenCalled();
      const [operation] = await operations();
      expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
      await expectBlockedReplay(operation.id);
      if (change === 'deletion') await expectNoCreatedArtifacts();
      else {
        expect(await identityOf(CREATED)).toBe(racedIdentity);
        expect(racedIdentity).not.toBe(hostIdentityId);
        expect(await getAuthorizationFingerprint([HOST, HOST_SIBLING, CREATED])).toBe('');
      }
    },
  );

  it.each(['confirmed', 'timeout', 'error'] as const)(
    'records compensation deletion only after confirmation (%s) and keeps provider deletion replay distinct', async (outcome) => {
      let failed = false;
      const observed = observedPool({
        before: async (sql, params, query) => {
          if (!failed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
            failed = true;
            await query('SELECT 1 / 0');
          }
        },
      });
      if (outcome === 'timeout') {
        provider.deleteUser.mockRejectedValueOnce(Object.assign(new Error(SECRET), { code: 'ETIMEDOUT' }));
      } else if (outcome === 'error') {
        provider.deleteUser.mockRejectedValueOnce(Object.assign(new Error(SECRET), { status: 503 }));
      }

      const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

      expect(failed).toBe(true);
      if (outcome === 'confirmed') expect(result.body.compensated).toBe(true);
      else expect(result.body.reconciliation_required).toBe(true);
      expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
      const beforeProviderDeletion = await pool.query<{ action: string }>(
        `SELECT action FROM registry_audit_log WHERE workos_user_id = $1
         AND action IN ('identity_credential_deleted', 'identity_credential_admin_compensation_deleted')`,
        [CREATED],
      );
      const delayedCreation = delayedCreationCallback();
      await expectOwnCompensationQuarantine((await operations())[0].id);
      if (outcome === 'confirmed') {
        expect(beforeProviderDeletion.rows).toEqual([{ action: 'identity_credential_admin_compensation_deleted' }]);
      } else {
        // The pre-delete quarantine is truthful containment. It blocks late
        // creation without falsely attesting that the provider user is gone.
        expect(beforeProviderDeletion.rows).toEqual([]);
        await expectBlockedReplay((await operations())[0].id);
      }
      expect(await readCredentialAuthorizationLifecycle(CREATED)).toEqual({ status: 'terminal', reason: 'deleted_or_quarantined' });
      expect(await withCredentialCreationEventMutation(CREATED, delayedCreation)).toEqual({ applied: false });
      expect(delayedCreation).not.toHaveBeenCalled();
      await expectNoCreatedArtifacts(observed.createdIdentities);

      // A later signed deletion event remains distinct from the local
      // confirmed compensation and produces its own truthful replay record.
      const confirmedDeletion = await deleteIdentityCredentialTransaction(CREATED, 'workos_webhook');
      expect(confirmedDeletion.deleted).toBe(false);
      expect(confirmedDeletion.replay).toBeNull();
      const deletionReplay = await deleteIdentityCredentialTransaction(CREATED, 'workos_webhook');
      expect(deletionReplay.replay).toMatchObject({ kind: 'same_source', original_deletion_source: 'workos_webhook' });
      expect((await pool.query(
        `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1 AND action = 'identity_credential_deleted'`, [CREATED],
      )).rows).toHaveLength(1);
      expect(await withCredentialCreationEventMutation(CREATED, delayedCreation)).toEqual({ applied: false });
      expect(delayedCreation).not.toHaveBeenCalled();
      expect(JSON.stringify({ result, logs: Object.values(logs).map((log) => log.mock.calls) })).not.toContain(SECRET);
    },
  );

  it('requires reconciliation if the confirmed compensation marker cannot be durably recorded', async () => {
    let localFailed = false;
    let markerFailed = false;
    const observed = observedPool({
      before: async (sql, params, query) => {
        if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
          localFailed = true;
          await query('SELECT 1 / 0');
        }
      },
      after: async (sql, _params, result) => {
        if (!markerFailed && sql.includes('INSERT INTO registry_audit_log')
          && sql.includes('identity_credential_admin_compensation_deleted')) {
          markerFailed = true;
          return { ...result, rowCount: 0 };
        }
      },
    });

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(localFailed && markerFailed).toBe(true);
    expect(result.body.reconciliation_required).toBe(true);
    expect(result.body.compensated).not.toBe(true);
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    const [operation] = await operations();
    expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
    expect(operation.failure_code).toBeTruthy();
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1
       AND action = 'identity_credential_admin_compensation_deleted'`, [CREATED],
    )).rows).toEqual([]);
    await expectOwnCompensationQuarantine(operation.id);
    await expectDelayedCreationBlocked();
    await expectNoCreatedArtifacts();
    await expectBlockedReplay(operation.id);
    expect(provider.deleteUser).toHaveBeenCalledTimes(1);
  });

  it('preserves a committed compensation marker after a lost COMMIT reply without claiming success or replaying deletion', async () => {
    let localFailed = false;
    let replyLost = false;
    const observed = observedPool({
      before: async (sql, params, query) => {
        if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
          localFailed = true;
          await query('SELECT 1 / 0');
        }
      },
      after: async (sql) => {
        if (!replyLost && sql.trim() === 'COMMIT' && provider.deleteUser.mock.calls.length === 1) {
          replyLost = true;
          throw Object.assign(new Error('compensation commit reply lost'), { code: 'ECONNRESET' });
        }
      },
    });

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(localFailed && replyLost).toBe(true);
    expect(result.body.reconciliation_required).toBe(true);
    expect(result.body.compensated).not.toBe(true);
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    const [operation] = await operations();
    expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1
       AND action = 'identity_credential_admin_compensation_deleted'`, [CREATED],
    )).rows).toHaveLength(1);
    expect(await readCredentialAuthorizationLifecycle(CREATED)).toEqual({ status: 'terminal', reason: 'deleted_or_quarantined' });
    await expectOwnCompensationQuarantine(operation.id);
    await expectDelayedCreationBlocked();
    await expectNoCreatedArtifacts();
    await expectBlockedReplay(operation.id);
    expect(provider.deleteUser).toHaveBeenCalledTimes(1);
  });

  it.each(['insert_error', 'insert_cardinality', 'audit_cardinality', 'commit_error', 'commit_receipt', 'commit_reply_lost'] as const)(
    'does not delete upstream before compensation quarantine is confirmed (%s)', async (fault) => {
      let localFailed = false;
      let quarantineStarted = false;
      let injected = false;
      const observed = observedPool({
        before: async (sql, params, query) => {
          if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
            localFailed = true;
            await query('SELECT 1 / 0');
          }
          if (sql.includes('INSERT INTO registry_audit_log')
            && sql.includes('identity_credential_admin_compensation_quarantined')) {
            quarantineStarted = true;
            if (fault === 'insert_error' && !injected) {
              injected = true;
              throw new Error(SECRET);
            }
          }
          if (!injected && fault === 'commit_error' && quarantineStarted
            && sql.trim() === 'COMMIT' && provider.deleteUser.mock.calls.length === 0) {
            injected = true;
            throw new Error(SECRET);
          }
        },
        after: async (sql, params, result) => {
          if (!injected && fault === 'insert_cardinality' && sql.includes('INSERT INTO registry_audit_log')
            && sql.includes('identity_credential_admin_compensation_quarantined')) {
            injected = true;
            return { ...result, rows: [], rowCount: 0 };
          }
          if (!injected && fault === 'audit_cardinality' && sql.includes('UPDATE admin_credential_bind_operations')
            && params?.[1] === 'compensating') {
            injected = true;
            return { ...result, rowCount: 0 };
          }
          if (!injected && quarantineStarted && sql.trim() === 'COMMIT'
            && provider.deleteUser.mock.calls.length === 0 && ['commit_receipt', 'commit_reply_lost'].includes(fault)) {
            injected = true;
            if (fault === 'commit_reply_lost') throw Object.assign(new Error(SECRET), { code: 'ECONNRESET' });
            return { ...result, command: 'ROLLBACK' };
          }
        },
      });

      const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

      expect(localFailed && quarantineStarted && injected).toBe(true);
      expect(result.body.reconciliation_required).toBe(true);
      expect(result.body.compensated).not.toBe(true);
      expect(provider.deleteUser).not.toHaveBeenCalled();
      const [operation] = await operations();
      expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
      if (fault === 'commit_receipt' || fault === 'commit_reply_lost') {
        // The actual quarantine COMMIT succeeded; its reply did not attest
        // that outcome, so upstream deletion still must not be attempted.
        await expectOwnCompensationQuarantine(operation.id);
        await expectDelayedCreationBlocked();
      } else {
        expect((await pool.query(
          `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1
           AND action = 'identity_credential_admin_compensation_quarantined'`, [CREATED],
        )).rows).toEqual([]);
      }
      await expectNoCreatedArtifacts();
      await expectBlockedReplay(operation.id);
      expect(JSON.stringify({ result, operation, logs: Object.values(logs).map((log) => log.mock.calls) })).not.toContain(SECRET);
    },
  );

  it.each(['operation_id', 'provider_user_id', 'acting_workos_user_id', 'actor_identity_id', 'resource_id', 'resource_type'] as const)(
    'refuses upstream deletion if committed quarantine has conflicting %s', async (field) => {
      let localFailed = false;
      let quarantineStarted = false;
      let changed = false;
      let changedRows: number | null = null;
      const observed = observedPool({
        before: async (sql, params, query) => {
          if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
            localFailed = true;
            await query('SELECT 1 / 0');
          }
        },
        after: async (sql) => {
          if (sql.includes('INSERT INTO registry_audit_log')
            && sql.includes('identity_credential_admin_compensation_quarantined')) quarantineStarted = true;
          if (!changed && quarantineStarted && sql.trim() === 'COMMIT' && provider.deleteUser.mock.calls.length === 0) {
            changed = true;
            const conflictingValues = {
              operation_id: '00000000-0000-0000-0000-000000000001',
              provider_user_id: HOST,
              acting_workos_user_id: ACTOR_PRIMARY,
              actor_identity_id: hostIdentityId,
              resource_id: '00000000-0000-0000-0000-000000000001',
              resource_type: 'identity_credential',
            };
            if (field === 'resource_id' || field === 'resource_type') {
              const sql = field === 'resource_id'
                ? `UPDATE registry_audit_log SET resource_id = $1::text
                   WHERE workos_user_id = $2 AND action = 'identity_credential_admin_compensation_quarantined'`
                : `UPDATE registry_audit_log SET resource_type = $1::text
                   WHERE workos_user_id = $2 AND action = 'identity_credential_admin_compensation_quarantined'`;
              changedRows = (await pool.query(sql, [conflictingValues[field], CREATED])).rowCount;
            } else {
              changedRows = (await pool.query(
                `UPDATE registry_audit_log SET details = jsonb_set(details, ARRAY[$1::text], to_jsonb($2::text), true)
                 WHERE workos_user_id = $3 AND action = 'identity_credential_admin_compensation_quarantined'`,
                [field, conflictingValues[field], CREATED],
              )).rowCount;
            }
          }
        },
      });

      const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

      expect(localFailed && changed).toBe(true);
      expect(changedRows).toBe(1);
      expect(result.body.reconciliation_required).toBe(true);
      expect(provider.deleteUser).not.toHaveBeenCalled();
      await expectDelayedCreationBlocked();
      await expectNoCreatedArtifacts();
      await expectBlockedReplay((await operations())[0].id);
    },
  );

  it('rejects a creation callback delivered between quarantine commit and lifecycle lock reacquisition', async () => {
    let localFailed = false;
    let quarantineStarted = false;
    let delivered = false;
    const callback = delayedCreationCallback();
    const observed = observedPool({
      before: async (sql, params, query) => {
        if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
          localFailed = true;
          await query('SELECT 1 / 0');
        }
      },
      after: async (sql) => {
        if (sql.includes('INSERT INTO registry_audit_log')
          && sql.includes('identity_credential_admin_compensation_quarantined')) quarantineStarted = true;
        if (!delivered && quarantineStarted && sql.trim() === 'COMMIT' && provider.deleteUser.mock.calls.length === 0) {
          delivered = true;
          const [operation] = await operations();
          expect(operation.status).toBe('compensating');
          await expectOwnCompensationQuarantine(operation.id);
          expect(await withCredentialCreationEventMutation(CREATED, callback)).toEqual({ applied: false });
        }
      },
    });

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(localFailed && delivered).toBe(true);
    expect(result.body.compensated).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    await expectOwnCompensationQuarantine((await operations())[0].id);
    await expectNoCreatedArtifacts();
  });

  it('preserves signed deletion delivered between quarantine commit and reacquisition without another provider delete', async () => {
    let localFailed = false;
    let quarantineStarted = false;
    let delivered = false;
    let signedDeletion: Awaited<ReturnType<typeof deleteIdentityCredentialTransaction>> | undefined;
    const observed = observedPool({
      before: async (sql, params, query) => {
        if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
          localFailed = true;
          await query('SELECT 1 / 0');
        }
      },
      after: async (sql) => {
        if (sql.includes('INSERT INTO registry_audit_log')
          && sql.includes('identity_credential_admin_compensation_quarantined')) quarantineStarted = true;
        if (!delivered && quarantineStarted && sql.trim() === 'COMMIT' && provider.deleteUser.mock.calls.length === 0) {
          delivered = true;
          signedDeletion = await deleteIdentityCredentialTransaction(CREATED, 'workos_webhook');
        }
      },
    });

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(localFailed && delivered).toBe(true);
    expect(signedDeletion?.deleted).toBe(false);
    expect(signedDeletion?.replay).toBeNull();
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.reconciliation_required).toBe(true);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    const [operation] = await operations();
    await expectOwnCompensationQuarantine(operation.id);
    expect((await pool.query(
      `SELECT details->>'deletion_source' AS deletion_source,
              details->'actor'->>'type' AS actor_type
       FROM registry_audit_log WHERE workos_user_id = $1 AND action = 'identity_credential_deleted'`, [CREATED],
    )).rows).toEqual([{ deletion_source: 'workos_webhook', actor_type: 'workos_provider' }]);
    const replay = await deleteIdentityCredentialTransaction(CREATED, 'workos_webhook');
    expect(replay.replay).toMatchObject({ kind: 'same_source', original_deletion_source: 'workos_webhook' });
    await expectDelayedCreationBlocked();
    await expectNoCreatedArtifacts();
    await expectBlockedReplay(operation.id);
  });

  it('holds the lifecycle lock from provider deletion through confirmed evidence and compensation commit', async () => {
    const atProviderDelete = deferred<void>();
    const releaseProviderDelete = deferred<void>();
    const atCompensationCommit = deferred<void>();
    const releaseCompensationCommit = deferred<void>();
    let localFailed = false;
    let confirmedMarkerInserted = false;
    let creationSettled = false;
    const callback = delayedCreationCallback();
    provider.deleteUser.mockImplementationOnce(async () => {
      atProviderDelete.resolve();
      await releaseProviderDelete.promise;
    });
    const observed = observedPool({
      before: async (sql, params, query) => {
        if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
          localFailed = true;
          await query('SELECT 1 / 0');
        }
        if (confirmedMarkerInserted && sql.trim() === 'COMMIT') {
          atCompensationCommit.resolve();
          await releaseCompensationCommit.promise;
        }
      },
      after: async (sql) => {
        if (sql.includes('INSERT INTO registry_audit_log')
          && sql.includes('identity_credential_admin_compensation_deleted')) confirmedMarkerInserted = true;
      },
    });
    const binding = createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });
    await Promise.race([
      atProviderDelete.promise,
      binding.then(() => { throw new Error('Compensation did not enter the provider deletion barrier'); }),
    ]);
    const creation = withCredentialCreationEventMutation(CREATED, callback).then(
      (value) => { creationSettled = true; return { value, error: undefined }; },
      (error: Error) => { creationSettled = true; return { value: undefined, error }; },
    );
    async function expectCreationWaitingOnLifecycleLock() {
      await expect.poll(async () => (await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks waiting JOIN pg_locks holder
             ON waiting.locktype = holder.locktype AND waiting.database = holder.database
            AND waiting.classid = holder.classid AND waiting.objid = holder.objid
            AND waiting.objsubid = holder.objsubid
          WHERE waiting.locktype = 'advisory' AND NOT waiting.granted AND holder.granted
            AND holder.pid = $1
            AND holder.classid = ((hashtextextended($2, 6827) >> 32) & 4294967295)::oid
            AND holder.objid = (hashtextextended($2, 6827) & 4294967295)::oid
        ) AS blocked`, [observed.pid(), CREATED],
      )).rows[0].blocked, { timeout: 750, interval: 10 }).toBe(true);
    }
    try {
      await expectCreationWaitingOnLifecycleLock();
      expect(creationSettled).toBe(false);
      releaseProviderDelete.resolve();
      await Promise.race([
        atCompensationCommit.promise,
        binding.then(() => { throw new Error('Compensation did not reach its commit barrier'); }),
      ]);
      expect(confirmedMarkerInserted).toBe(true);
      // The marker is written on the saga session but remains uncommitted;
      // another session must still wait instead of observing a writable gap.
      expect((await pool.query(
        `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1
         AND action = 'identity_credential_admin_compensation_deleted'`, [CREATED],
      )).rows).toEqual([]);
      await expectCreationWaitingOnLifecycleLock();
      expect(creationSettled).toBe(false);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      releaseProviderDelete.resolve();
      releaseCompensationCommit.resolve();
    }

    const result = await binding;
    const delivery = await creation;
    expect(result.body.compensated).toBe(true);
    expect(delivery.error).toBeUndefined();
    expect(delivery.value).toEqual({ applied: false });
    expect(callback).not.toHaveBeenCalled();
    expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1
       AND action = 'identity_credential_admin_compensation_deleted'`, [CREATED],
    )).rows).toHaveLength(1);
    await expectOwnCompensationQuarantine((await operations())[0].id);
    await expectNoCreatedArtifacts();
  });

  it('does not delete upstream when the quarantine ownership query has an incomplete receipt', async () => {
    let localFailed = false;
    let injected = false;
    const observed = observedPool({
      before: async (sql, params, query) => {
        if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
          localFailed = true;
          await query('SELECT 1 / 0');
        }
      },
      after: async (sql, _params, result) => {
        if (!injected && provider.deleteUser.mock.calls.length === 0
          && sql.includes('FROM registry_audit_log') && sql.includes('WHERE workos_user_id = $1')) {
          injected = true;
          return { ...result, rows: [], rowCount: 0 };
        }
      },
    });

    const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

    expect(localFailed && injected).toBe(true);
    expect(result.body.reconciliation_required).toBe(true);
    expect(provider.deleteUser).not.toHaveBeenCalled();
    const [operation] = await operations();
    await expectOwnCompensationQuarantine(operation.id);
    await expectDelayedCreationBlocked();
    await expectNoCreatedArtifacts();
    await expectBlockedReplay(operation.id);
  });

  it.each(['audit_cardinality', 'commit_error'] as const)(
    'retains quarantine if confirmed-deletion evidence rolls back (%s)', async (fault) => {
      let localFailed = false;
      let injected = false;
      const observed = observedPool({
        before: async (sql, params, query) => {
          if (!localFailed && sql.includes('INSERT INTO users') && params?.[0] === CREATED) {
            localFailed = true;
            await query('SELECT 1 / 0');
          }
          if (!injected && fault === 'commit_error' && sql.trim() === 'COMMIT'
            && provider.deleteUser.mock.calls.length === 1) {
            injected = true;
            throw new Error(SECRET);
          }
        },
        after: async (sql, params, result) => {
          if (!injected && fault === 'audit_cardinality' && sql.includes('UPDATE admin_credential_bind_operations')
            && params?.[1] === 'compensated') {
            injected = true;
            return { ...result, rowCount: 0 };
          }
        },
      });

      const result = await createAndBindAdminCredential(input(), { pool: observed.pool, workos: provider });

      expect(localFailed && injected).toBe(true);
      expect(result.body.reconciliation_required).toBe(true);
      expect(provider.deleteUser).toHaveBeenCalledExactlyOnceWith(CREATED);
      const [operation] = await operations();
      expect(operation).toMatchObject({ status: 'reconciliation_required', provider_user_id: CREATED });
      await expectOwnCompensationQuarantine(operation.id);
      expect((await pool.query(
        `SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1
         AND action = 'identity_credential_admin_compensation_deleted'`, [CREATED],
      )).rows).toEqual([]);
      await expectDelayedCreationBlocked();
      await expectNoCreatedArtifacts();
      await expectBlockedReplay(operation.id);
    },
  );
});
