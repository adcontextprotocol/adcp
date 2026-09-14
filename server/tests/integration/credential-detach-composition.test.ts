/** Real transactions; query barriers establish ownership before each competing mutation. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';

const provider = vi.hoisted(() => ({
  createUser: vi.fn(), deleteUser: vi.fn(), getUser: vi.fn(), listUsers: vi.fn(),
  createOrganizationMembership: vi.fn(), updateOrganizationMembership: vi.fn(), deleteOrganizationMembership: vi.fn(),
}));
vi.mock('../../src/auth/workos-client.js', () => ({
  getAdminCredentialMutationWorkos: () => ({ userManagement: provider }),
}));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));
vi.mock('../../src/db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/client.js')>();
  return { ...actual, getPool: vi.fn(actual.getPool) };
});

import { closeDatabase, getPool, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CredentialDetachConflict, detachCredential } from '../../src/db/credential-detach-db.js';
import { deleteIdentityCredentialTransaction } from '../../src/db/identity-db.js';
import { readCredentialAuthorizationLifecycle } from '../../src/db/authorization-epoch-db.js';
import { createAndBindAdminCredential } from '../../src/services/admin-credential-bind.js';

const PREFIX = `user_detach_composition_${randomUUID().slice(0, 8)}_`;
const [HOST, SIBLING, OTHER_HOST, ACTOR_PRIMARY, ACTOR, CREATED] =
  ['sam', 'sam_existing', 'priya', 'jordan', 'jordan_credential', 'sam_new'].map(role => `${PREFIX}${role}`);
const EXISTING = [HOST, SIBLING, OTHER_HOST, ACTOR_PRIMARY, ACTOR];
const USERS = [...EXISTING, CREATED];
const ORG = `org_${PREFIX}pinnacle`;
const EMAIL = `${PREFIX}sam.new@example.test`;
type RawQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>;
type QueryHook = (sql: string, params?: unknown[]) => Promise<void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
function pauseBefore(predicate: (sql: string, params?: unknown[]) => boolean) {
  const reached = deferred();
  const release = deferred();
  let paused = false;
  const before: QueryHook = async (sql, params) => {
    if (!paused && predicate(sql.replace(/\s+/g, ' '), params)) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
  };
  return { before, reached: reached.promise, release: release.resolve };
}
function settled<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
}
async function reach<T>(barrier: ReturnType<typeof pauseBefore>, pending: Promise<T>) {
  await Promise.race([barrier.reached, pending.then(() => { throw new Error('Operation finished before its query barrier'); })]);
}

describe('detach composes with credential binding and provider deletion', () => {
  let pool: Pool;
  let hostIdentityId: string;
  let actorIdentityId: string;
  const identities = new Set<string>();

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test' });
    await runMigrations();
  }, 60000);
  afterAll(async () => { if (pool) await cleanup(); await closeDatabase(); });
  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    for (const mock of Object.values(provider)) mock.mockReset();
    provider.createUser.mockResolvedValue({ id: CREATED, email: EMAIL, firstName: 'Sam', lastName: 'Adeyemi',
      emailVerified: true, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' });
    provider.deleteUser.mockResolvedValue(undefined);
    await pool.query(`INSERT INTO organizations (workos_organization_id, name, subscription_status, stripe_subscription_id)
      VALUES ($1, 'Pinnacle Agency', 'active', $2)`, [ORG, `${PREFIX}subscription`]);
    for (const id of EXISTING) {
      await pool.query('INSERT INTO users (workos_user_id, email, primary_organization_id) VALUES ($1, $2, $3)',
        [id, `${id}@example.test`, ORG]);
      identities.add((await binding(id)).identity_id);
    }
    hostIdentityId = (await binding(HOST)).identity_id;
    actorIdentityId = (await binding(ACTOR_PRIMARY)).identity_id;
    for (const [id, identity] of [[SIBLING, hostIdentityId], [ACTOR, actorIdentityId]]) {
      await pool.query('UPDATE identity_workos_users SET identity_id = $1, is_primary = FALSE WHERE workos_user_id = $2', [identity, id]);
    }
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, provisioning_source)
      VALUES ($1, $3, $4, 'sam@example.test', 'owner', 'invitation'),
        ($2, $3, $5, 'sam.credential@example.test', 'admin', 'sso')`,
    [HOST, SIBLING, ORG, `${PREFIX}membership1`, `${PREFIX}membership2`]);
    await pool.query(`INSERT INTO organization_credential_grants
      (workos_organization_id, workos_user_id, role, granted_by_workos_user_id, reason)
      VALUES ($1, $2, 'admin', $3, 'Original independent credential grant')`, [ORG, SIBLING, ACTOR]);
    const group = (await pool.query<{ id: string }>(
      "INSERT INTO working_groups (name, slug) VALUES ('Detach composition fixture', $1) RETURNING id", [PREFIX],
    )).rows[0].id;
    await pool.query(`INSERT INTO working_group_memberships (working_group_id, workos_user_id, added_by_user_id)
      VALUES ($1, $2, $3), ((SELECT id FROM working_groups WHERE slug = 'aao-admin'), $2, $3)`, [group, SIBLING, ACTOR]);
    await pool.query('INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)', [group, SIBLING]);
    await pool.query(`INSERT INTO working_group_topic_subscriptions (working_group_id, workos_user_id, topic_slugs)
      VALUES ($1, $2, '{original-topic}')`, [group, SIBLING]);
    await pool.query(`INSERT INTO subscription_line_items
      (workos_organization_id, stripe_subscription_id, stripe_subscription_item_id, price_id, quantity, metadata)
      VALUES ($1, $2, $3, 'price_original', 3, '{"source":"billing"}')`, [ORG, `${PREFIX}subscription`, `${PREFIX}item`]);
  });

  async function binding(id: string) {
    return (await pool.query<{ identity_id: string; is_primary: boolean }>(
      'SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1', [id],
    )).rows[0];
  }
  async function cleanup() {
    for (const row of (await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [USERS],
    )).rows) identities.add(row.identity_id);
    await pool.query(`DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)
      OR details->>'host_user_id' = ANY($1) OR resource_id = ANY($1)`, [USERS]);
    await pool.query('DELETE FROM admin_credential_bind_operations WHERE host_user_id = ANY($1)', [USERS]);
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [USERS]);
    await pool.query('DELETE FROM working_groups WHERE slug = $1', [PREFIX]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [USERS]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [USERS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG]);
    if (identities.size) await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [[...identities]]);
    identities.clear();
  }
  function bindInput(hostUserId = HOST) { return { hostUserId, email: EMAIL, actorUserId: ACTOR, actorIdentityId }; }
  async function detachInput(credentialId = SIBLING) {
    const epoch = (await pool.query<{ epoch: string }>('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id = $1', [credentialId])).rows[0]?.epoch ?? '0';
    return { hostUserId: HOST, credentialId, expectedIdentityId: hostIdentityId, expectedAuthorizationEpoch: epoch,
      actorUserId: ACTOR_PRIMARY, actorCredentialId: ACTOR, actorIdentityId };
  }
  async function authoritySnapshot(ids = EXISTING) {
    const queries = [
      ['users', 'workos_user_id = ANY($1)', ids],
      ['organization_memberships', 'workos_user_id = ANY($1)', ids],
      ['organization_credential_grants', 'workos_user_id = ANY($1)', ids],
      ['working_group_memberships', 'workos_user_id = ANY($1)', ids],
      ['working_group_leaders', 'user_id = ANY($1)', ids],
      ['working_group_topic_subscriptions', 'workos_user_id = ANY($1)', ids],
      ['organizations', 'workos_organization_id = ANY($1)', [ORG]],
      ['subscription_line_items', 'workos_organization_id = ANY($1)', [ORG]],
    ] as const;
    return Object.fromEntries(await Promise.all(queries.map(async ([table, where, values]) => [table,
      (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`, [values])).rows,
    ])));
  }
  async function detachSnapshot() {
    return {
      bindings: (await pool.query('SELECT * FROM identity_workos_users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USERS])).rows,
      epochs: (await pool.query('SELECT * FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USERS])).rows,
      audits: (await pool.query("SELECT * FROM registry_audit_log WHERE action = 'unbind_credential' AND resource_id = ANY($1) ORDER BY id", [USERS])).rows,
    };
  }
  async function operations() {
    return (await pool.query('SELECT * FROM admin_credential_bind_operations WHERE host_user_id = ANY($1) ORDER BY id', [USERS])).rows;
  }
  async function fullState() {
    return { detach: await detachSnapshot(), authority: await authoritySnapshot(USERS), operations: await operations(),
      audits: (await pool.query('SELECT * FROM registry_audit_log WHERE workos_user_id = ANY($1) ORDER BY id', [USERS])).rows };
  }
  async function expectEpochs(expected: Record<string, string>) {
    const rows = (await pool.query<{ workos_user_id: string; epoch: string }>(
      'SELECT workos_user_id, epoch::text FROM authorization_epochs WHERE workos_user_id = ANY($1)', [USERS],
    )).rows;
    expect(Object.fromEntries(rows.map(row => [row.workos_user_id, row.epoch]))).toEqual(expected);
  }
  function expectProviderCalls(creates: number) {
    expect(provider.createUser).toHaveBeenCalledTimes(creates);
    for (const [name, mock] of Object.entries(provider)) if (name !== 'createUser') expect(mock).not.toHaveBeenCalled();
  }
  async function expectOneDetach(credentialId: string) {
    const audit = (await detachSnapshot()).audits;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ workos_user_id: ACTOR_PRIMARY, resource_id: credentialId,
      details: { acting_workos_user_id: ACTOR, acting_identity_id: actorIdentityId,
        affected_workos_user_id: credentialId, detached_from_identity_id: hostIdentityId } });
    expect((await binding(credentialId)).is_primary).toBe(true);
    expect((await binding(credentialId)).identity_id).not.toBe(hostIdentityId);
  }
  function observedPool(before: QueryHook) {
    let pid: number | undefined;
    const proxy = new Proxy(pool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        const query: RawQuery = client.query.bind(client);
        const release = client.release.bind(client);
        pid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        client.query = (async (sql: string, params?: unknown[]) => {
          await before(sql, params);
          return query(sql, params);
        }) as PoolClient['query'];
        client.release = (error?: boolean | Error) => {
          client.query = query as PoolClient['query']; client.release = release; release(error);
        };
        return client;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { pool: proxy, pid: () => pid };
  }
  async function expectAdvisoryWait(waiter: () => number | undefined, holder: () => number | undefined) {
    await expect.poll(async () => (await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks waiting JOIN pg_locks holder
         ON waiting.locktype = holder.locktype AND waiting.database = holder.database
        AND waiting.classid = holder.classid AND waiting.objid = holder.objid AND waiting.objsubid = holder.objsubid
       WHERE waiting.locktype = 'advisory' AND NOT waiting.granted AND holder.granted
         AND waiting.pid = $1 AND holder.pid = $2) AS blocked`, [waiter(), holder()],
    )).rows[0].blocked, { timeout: 2000, interval: 10 }).toBe(true);
  }

  it.each(['credential fence', 'binding rows', 'identity rows'] as const)(
    'rejects detach while a fresh bind owns %s without changing detach or authority state', async (phase) => {
    const input = await detachInput();
    const authority = await authoritySnapshot();
    const barrier = pauseBefore((sql, params) => phase === 'credential fence'
      ? sql.includes('SELECT workos_user_id, identity_id FROM identity_workos_users')
      : phase === 'binding rows' ? sql.includes('SELECT id FROM identities')
        : sql.includes('INSERT INTO users') && params?.[0] === CREATED);
    const observed = observedPool(barrier.before);
    const pending = settled(createAndBindAdminCredential(bindInput(), { pool: observed.pool, workos: provider }));
    try {
      await reach(barrier, pending);
      const before = await fullState();
      await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
      expect(await fullState()).toEqual(before);
    } finally { barrier.release(); await pending; }
    expect((await pending).value?.status).toBe(201);
    expect(await authoritySnapshot()).toEqual(authority);
    expect((await detachSnapshot()).audits).toEqual([]);
    await expectEpochs({ [HOST]: '1', [SIBLING]: '1', [CREATED]: '1' });
    expectProviderCalls(1);
  });

  it('serializes a fresh bind after detach and bumps only the remaining host graph', async () => {
    const input = await detachInput();
    const authority = await authoritySnapshot();
    const barrier = pauseBefore(sql => sql.includes('INSERT INTO registry_audit_log') && sql.includes('unbind_credential'));
    const observedDetach = observedPool(barrier.before);
    vi.mocked(getPool).mockReturnValueOnce(observedDetach.pool);
    const detaching = settled(detachCredential(input));
    let bindingOperation: ReturnType<typeof settled<Awaited<ReturnType<typeof createAndBindAdminCredential>>>> | undefined;
    try {
      await reach(barrier, detaching);
      const observedBind = observedPool(async () => {});
      bindingOperation = settled(createAndBindAdminCredential(bindInput(), { pool: observedBind.pool, workos: provider }));
      await expectAdvisoryWait(observedBind.pid, observedDetach.pid);
    } finally { barrier.release(); await detaching; await bindingOperation; }
    expect((await detaching).error).toBeUndefined();
    expect((await bindingOperation!).value?.status).toBe(201);
    expect(await authoritySnapshot()).toEqual(authority);
    await expectOneDetach(SIBLING);
    expect((await binding(CREATED)).identity_id).toBe(hostIdentityId);
    await expectEpochs({ [HOST]: '2', [SIBLING]: '1', [CREATED]: '1' });
    expectProviderCalls(1);
  });

  it('rejects detach while authoritative deletion owns the credential fence', async () => {
    const input = await detachInput();
    const barrier = pauseBefore((sql, params) => sql.includes('SELECT identity_id FROM identity_workos_users')
      && sql.includes('FOR UPDATE') && params?.[0] === SIBLING);
    const observed = observedPool(barrier.before);
    vi.mocked(getPool).mockReturnValueOnce(observed.pool);
    const deleting = settled(deleteIdentityCredentialTransaction(SIBLING, 'workos_webhook'));
    try {
      await reach(barrier, deleting);
      const before = await fullState();
      await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
      expect(await fullState()).toEqual(before);
    } finally { barrier.release(); await deleting; }
    expect((await deleting).value?.deleted).toBe(true);
    expect((await detachSnapshot()).audits).toEqual([]);
    expect(await binding(SIBLING)).toBeUndefined();
    expect((await pool.query("SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1 AND action = 'identity_credential_deleted'", [SIBLING])).rows).toHaveLength(1);
    await expectEpochs({ [HOST]: '1' });
    expectProviderCalls(0);
  });

  it('forces deletion to re-read a detached credential before its authoritative retry', async () => {
    const input = await detachInput();
    const authority = await authoritySnapshot();
    const barrier = pauseBefore(sql => sql.includes('INSERT INTO registry_audit_log') && sql.includes('unbind_credential'));
    const observedDetach = observedPool(barrier.before);
    vi.mocked(getPool).mockReturnValueOnce(observedDetach.pool);
    const detaching = settled(detachCredential(input));
    let deleting: ReturnType<typeof settled<Awaited<ReturnType<typeof deleteIdentityCredentialTransaction>>>> | undefined;
    try {
      await reach(barrier, detaching);
      const observedDelete = observedPool(async () => {});
      vi.mocked(getPool).mockReturnValueOnce(observedDelete.pool);
      deleting = settled(deleteIdentityCredentialTransaction(SIBLING, 'workos_webhook'));
      await expectAdvisoryWait(observedDelete.pid, observedDetach.pid);
    } finally { barrier.release(); await detaching; await deleting; }
    expect((await detaching).error).toBeUndefined();
    expect((await deleting!).error?.message).toBe('Credential identity changed while acquiring deletion locks');
    expect(await authoritySnapshot()).toEqual(authority);
    await expectOneDetach(SIBLING);
    await expectEpochs({ [HOST]: '1', [SIBLING]: '1' });
    expect((await pool.query("SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1 AND action = 'identity_credential_deleted'", [SIBLING])).rows).toEqual([]);
    expect((await deleteIdentityCredentialTransaction(SIBLING, 'workos_webhook')).deleted).toBe(true);
    expect((await detachSnapshot()).audits).toHaveLength(1);
    expect(await binding(SIBLING)).toBeUndefined();
    expect((await pool.query("SELECT 1 FROM registry_audit_log WHERE workos_user_id = $1 AND action = 'identity_credential_deleted'", [SIBLING])).rows).toHaveLength(1);
    await expectEpochs({ [HOST]: '1' });
    expectProviderCalls(0);
  });

  it('rejects a captured secondary-actor request when its canonical primary is deleted before detach locks', async () => {
    const input = await detachInput();
    const barrier = pauseBefore(sql => sql.includes('pg_try_advisory_lock('));
    const observed = observedPool(barrier.before);
    vi.mocked(getPool).mockReturnValueOnce(observed.pool);
    const detaching = settled(detachCredential(input));
    let afterDeletion: Awaited<ReturnType<typeof fullState>> | undefined;
    try {
      await reach(barrier, detaching);
      expect((await deleteIdentityCredentialTransaction(ACTOR_PRIMARY, 'workos_webhook')).deleted).toBe(true);
      expect(await readCredentialAuthorizationLifecycle(ACTOR)).toEqual({ status: 'terminal', reason: 'missing_primary' });
      afterDeletion = await fullState();
    } finally { barrier.release(); await detaching; }
    expect((await detaching).error).toBeInstanceOf(CredentialDetachConflict);
    expect(await fullState()).toEqual(afterDeletion);
    expect((await binding(SIBLING)).identity_id).toBe(hostIdentityId);
    expect((await detachSnapshot()).audits).toEqual([]);
    await expectEpochs({ [ACTOR]: '1' });
    expectProviderCalls(0);
  });

  it.each(['same host', 'conflicting host'] as const)('keeps bind → detach → %s replay from rebinding or changing authority', async (replay) => {
    const created = await createAndBindAdminCredential(bindInput(), { workos: provider });
    expect(created.status).toBe(201);
    const journalBefore = await operations();
    const authority = await authoritySnapshot(USERS);
    await detachCredential(await detachInput(CREATED));
    expect(await operations()).toEqual(journalBefore);
    await expectOneDetach(CREATED);
    await expectEpochs({ [HOST]: '2', [SIBLING]: '2', [CREATED]: '2' });
    const detached = await detachSnapshot();
    const replayInput = bindInput(replay === 'same host' ? HOST : OTHER_HOST);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await createAndBindAdminCredential(replayInput, { workos: provider });
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ reconciliation_required: true, operation_id: created.body.operation_id });
      expect(await detachSnapshot()).toEqual(detached);
      expect(await authoritySnapshot(USERS)).toEqual(authority);
    }
    const journal = await operations();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ id: created.body.operation_id,
      status: replay === 'same host' ? 'reconciliation_required' : 'committed', provider_user_id: CREATED });
    expectProviderCalls(1);
  });

  it('rejects a concurrent journal reconciliation transition, then rejects its committed status without mutation', async () => {
    const created = await createAndBindAdminCredential(bindInput(), { workos: provider });
    expect(created.status).toBe(201);
    const input = await detachInput(CREATED);
    const before = await fullState();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      // Parent replay can transition this row after releasing its lifecycle transaction.
      await writer.query(`UPDATE admin_credential_bind_operations
        SET status = 'reconciliation_required', updated_at = NOW() WHERE id = $1`, [created.body.operation_id]);
      await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
      expect(await fullState()).toEqual(before);
      await writer.query('COMMIT');
      const reconciled = await fullState();
      await expect(detachCredential(input)).rejects.toBeInstanceOf(CredentialDetachConflict);
      expect(await fullState()).toEqual(reconciled);
    } finally { await writer.query('ROLLBACK'); writer.release(); }
    expect((await binding(CREATED)).identity_id).toBe(hostIdentityId);
    expect((await detachSnapshot()).audits).toEqual([]);
    await expectEpochs({ [HOST]: '1', [SIBLING]: '1', [CREATED]: '1' });
    expectProviderCalls(1);
  });

  it('holds the committed bind operation row through detach commit before a later reconciliation write', async () => {
    const created = await createAndBindAdminCredential(bindInput(), { workos: provider });
    expect(created.status).toBe(201);
    const input = await detachInput(CREATED);
    const authority = await authoritySnapshot(USERS);
    const barrier = pauseBefore(sql => sql.includes('INSERT INTO registry_audit_log') && sql.includes('unbind_credential'));
    const observed = observedPool(barrier.before);
    vi.mocked(getPool).mockReturnValueOnce(observed.pool);
    const detaching = settled(detachCredential(input));
    const writer = await pool.connect();
    let writing: ReturnType<typeof settled<QueryResult>> | undefined;
    try {
      await reach(barrier, detaching);
      await writer.query('BEGIN');
      const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      writing = settled(writer.query(`UPDATE admin_credential_bind_operations
        SET status = 'reconciliation_required', updated_at = NOW() WHERE id = $1`, [created.body.operation_id]));
      await expect.poll(async () => (await pool.query<{ blocked: boolean }>(
        'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked', [observed.pid(), writerPid],
      )).rows[0].blocked, { timeout: 2000, interval: 10 }).toBe(true);
    } finally {
      barrier.release();
      await detaching;
      await writing;
      await writer.query('COMMIT');
      writer.release();
    }
    expect((await detaching).error).toBeUndefined();
    expect((await writing!).error).toBeUndefined();
    expect((await operations())[0].status).toBe('reconciliation_required');
    await expectOneDetach(CREATED);
    await expectEpochs({ [HOST]: '2', [SIBLING]: '2', [CREATED]: '2' });
    expect(await authoritySnapshot(USERS)).toEqual(authority);
    expectProviderCalls(1);
  });
});
