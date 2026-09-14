/**
 * Real requireAuth + requireAdmin + requireGlobalAdmin + admin router + PostgreSQL.
 * Only the external WorkOS SDK and unrelated ban/error-notification boundary are
 * mocked. In particular, no auth, membership, lifecycle, or saga mock hides the
 * difference between the signed-in credential and the identity's primary.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  authenticate: vi.fn(),
  loadSealedSession: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  createOrganizationMembership: vi.fn(),
  updateOrganizationMembership: vi.fn(),
  deleteOrganizationMembership: vi.fn(),
}));

vi.hoisted(() => {
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
  delete process.env.ALLOW_DEV_MODE_IN_PROD;
  delete process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_EMAILS;
  process.env.WORKOS_API_KEY = 'sk_test_admin_bind_exact_auth';
  process.env.WORKOS_CLIENT_ID = 'client_test_admin_bind_exact_auth';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-chars-long';
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return {
      userManagement: {
        loadSealedSession: sdk.loadSealedSession,
        createUser: sdk.createUser,
        deleteUser: sdk.deleteUser,
        createOrganizationMembership: sdk.createOrganizationMembership,
        updateOrganizationMembership: sdk.updateOrganizationMembership,
        deleteOrganizationMembership: sdk.deleteOrganizationMembership,
      },
      apiKeys: { createValidation: vi.fn() },
    };
  }),
}));
vi.mock('../../src/db/bans-db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/bans-db.js')>()),
  bansDb: {
    checkPlatformBan: vi.fn().mockResolvedValue({ banned: false, ban: null }),
    checkPlatformBanForApiKey: vi.fn().mockResolvedValue({ banned: false, ban: null }),
  },
}));
vi.mock('../../src/addie/error-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/error-notifier.js')>()),
  notifySystemError: vi.fn(),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { invalidateAllAdminStatusCaches } from '../../src/addie/admin-status-cache.js';
import { invalidateSessionsForUsers, stopAuthTimers } from '../../src/middleware/auth.js';
import { createAdminUsersRouter } from '../../src/routes/admin/users.js';

const PREFIX = 'user_admin_bind_exact_auth_';
const A = PREFIX + 'jordan_primary';
const B = PREFIX + 'jordan_linked';
const HOST = PREFIX + 'sam_host';
const CREATED = PREFIX + 'sam_new';
const IDS = [A, B, HOST, CREATED];
const A_EMAIL = 'jordan.admin@pinnacle.example';
const B_EMAIL = 'jordan.personal@pinnacle.example';
const NEW_EMAIL = 'sam.new@pinnacle.example';
const ORG = 'org_admin_bind_exact_auth_pinnacle';

type CapturedPrincipal = {
  id: string | undefined;
  authWorkosUserId: string | undefined;
  mechanism: string | undefined;
};

describe('fresh admin credential bind exact authenticated authority at the real route boundary', () => {
  let pool: Pool;
  let app: express.Express;
  let groupId: string;
  let createdGroupId: string | undefined;
  let actorIdentityId: string;
  let hostIdentityId: string;
  let sequence = 0;
  let observedSql: string[] = [];
  let observing = false;
  let failExactMembershipLookup = false;
  let membershipFailureInjected = false;
  let captured: CapturedPrincipal | undefined;
  let restoreQuery: (() => void) | undefined;
  const identityIds = new Set<string>();

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL
        || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    const created = await pool.query<{ id: string }>(
      "INSERT INTO working_groups (name, slug, is_private, status)"
      + " VALUES ('Admin authority boundary fixture', 'aao-admin', true, 'active')"
      + ' ON CONFLICT (slug) DO NOTHING RETURNING id',
    );
    createdGroupId = created.rows[0]?.id;
    groupId = (await pool.query<{ id: string }>(
      "SELECT id FROM working_groups WHERE slug = 'aao-admin'",
    )).rows[0].id;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, res, next) => {
      res.on('finish', () => {
        captured = {
          id: req.user?.id,
          authWorkosUserId: req.user?.authWorkosUserId,
          mechanism: req.adminAccessMechanism,
        };
      });
      next();
    });
    app.use('/api/admin/users', createAdminUsersRouter());

    // Observe checked-out clients as well as pool.query. A pool-only observer
    // misses the saga's transaction writes and cannot prove denied requests
    // never started a write. Fixture setup/cleanup is outside the observed span.
    const originalQuery = Client.prototype.query;
    const observer = vi.spyOn(Client.prototype, 'query').mockImplementation(
      function (this: Client, ...args: unknown[]) {
        const query = args[0] as string | { text?: string; values?: unknown[] };
        const sql = typeof query === 'string' ? query : query.text ?? '';
        const values = Array.isArray(args[1])
          ? args[1]
          : (typeof query === 'string' ? undefined : query.values);
        if (observing) {
          observedSql.push(sql);
          // Targets only the route's literal exact-credential lookup. The
          // inherited global lookup uses group UUID as its first parameter.
          if (failExactMembershipLookup
            && sql.includes('working_group_memberships')
            && sql.includes('working_groups')
            && values?.[0] === B) {
            membershipFailureInjected = true;
            throw new Error('Injected exact-credential authority lookup outage');
          }
        }
        return Reflect.apply(originalQuery, this, args);
      } as Client['query'],
    );
    restoreQuery = () => observer.mockRestore();
  }, 60000);

  beforeEach(async () => {
    observing = false;
    await cleanup();
    vi.clearAllMocks();
    invalidateAllAdminStatusCaches();
    invalidateSessionsForUsers(IDS);
    delete process.env.ADMIN_EMAILS;
    observedSql = [];
    captured = undefined;
    failExactMembershipLookup = false;
    membershipFailureInjected = false;

    for (const [id, email] of [
      [A, A_EMAIL], [B, B_EMAIL], [HOST, 'sam@pinnacle.example'],
    ]) {
      await pool.query(
        'INSERT INTO users (workos_user_id, email, first_name, last_name,'
        + ' email_verified, workos_created_at, workos_updated_at)'
        + " VALUES ($1, $2, 'Fixture', 'Person', true, NOW(), NOW())",
        [id, email],
      );
      identityIds.add(await identityOf(id));
    }
    actorIdentityId = await identityOf(A);
    hostIdentityId = await identityOf(HOST);
    await pool.query(
      'UPDATE identity_workos_users SET identity_id = $1, is_primary = false'
      + ' WHERE workos_user_id = $2',
      [actorIdentityId, B],
    );
    await grantAdmin(A);
    await pool.query(
      'INSERT INTO organizations (workos_organization_id, name)'
      + " VALUES ($1, 'Pinnacle Agency')", [ORG],
    );
    await pool.query(
      'INSERT INTO organization_memberships'
      + ' (workos_user_id, workos_organization_id, email, role)'
      + " VALUES ($1, $2, 'sam@pinnacle.example', 'admin')", [HOST, ORG],
    );
    sdk.loadSealedSession.mockReturnValue({
      authenticate: sdk.authenticate, refresh: vi.fn(),
    });
    sdk.createUser.mockResolvedValue({
      id: CREATED, email: NEW_EMAIL, firstName: 'Sam', lastName: 'Adeyemi',
      emailVerified: false, createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    sdk.deleteUser.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    observing = false;
    restoreQuery?.();
    stopAuthTimers();
    if (pool) {
      await cleanup();
      if (createdGroupId) {
        await pool.query('DELETE FROM working_groups WHERE id = $1', [createdGroupId]);
      }
    }
    await closeDatabase();
  });

  async function identityOf(id: string): Promise<string> {
    return (await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1',
      [id],
    )).rows[0].identity_id;
  }

  async function grantAdmin(id: string) {
    await pool.query(
      'INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)'
      + " VALUES ($1, $2, 'active')", [groupId, id],
    );
    invalidateAllAdminStatusCaches();
  }

  async function cleanup() {
    const bindings = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [IDS],
    );
    for (const row of bindings.rows) identityIds.add(row.identity_id);
    await pool.query(
      'DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)'
      + ' OR resource_id IN (SELECT id::text FROM admin_credential_bind_operations'
      + ' WHERE host_user_id = $2)', [IDS, HOST],
    );
    await pool.query('DELETE FROM admin_credential_bind_operations WHERE host_user_id = $1', [HOST]);
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [IDS]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [IDS]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [IDS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG]);
    if (identityIds.size) {
      await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [[...identityIds]]);
      identityIds.clear();
    }
  }

  async function snapshot() {
    // Separate stable SELECTs run before and after the HTTP request. All rows,
    // including epochs/timestamps, must remain byte-for-byte equal on refusal.
    const rows: Record<string, unknown[]> = {};
    for (const table of [
      'users', 'identity_workos_users', 'authorization_epochs',
      'working_group_memberships', 'organization_memberships',
    ]) {
      rows[table] = (await pool.query(
        'SELECT to_jsonb(row) AS row FROM ' + table
        + ' row WHERE workos_user_id = ANY($1) ORDER BY to_jsonb(row)::text', [IDS],
      )).rows;
    }
    rows.operations = (await pool.query(
      'SELECT to_jsonb(row) AS row FROM admin_credential_bind_operations row'
      + ' WHERE host_user_id = $1 ORDER BY id', [HOST],
    )).rows;
    rows.audit = (await pool.query(
      'SELECT to_jsonb(row) AS row FROM registry_audit_log row'
      + ' WHERE workos_user_id = ANY($1) OR resource_id IN'
      + ' (SELECT id::text FROM admin_credential_bind_operations WHERE host_user_id = $2)'
      + ' ORDER BY id', [IDS, HOST],
    )).rows;
    return rows;
  }

  async function postAs(id: string, sessionEmail = id === A ? A_EMAIL : B_EMAIL) {
    sdk.authenticate.mockResolvedValue({
      authenticated: true,
      user: {
        id, email: sessionEmail, firstName: 'Jordan', lastName: 'Ochoa',
        emailVerified: true, createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      accessToken: 'test-only-sdk-access-token',
    });
    observing = true;
    try {
      return await request(app)
        .post('/api/admin/users/' + HOST + '/linked-emails')
        .set('Accept', 'application/json')
        .set('Cookie', 'wos-session=exact-auth-fixture-' + (++sequence))
        .send({ email: NEW_EMAIL });
    } finally {
      observing = false;
    }
  }

  function expectNoProviderMutation() {
    for (const method of [
      sdk.createUser, sdk.deleteUser, sdk.createOrganizationMembership,
      sdk.updateOrganizationMembership, sdk.deleteOrganizationMembership,
    ]) expect(method).not.toHaveBeenCalled();
  }

  async function expectNoMutation(before: Awaited<ReturnType<typeof snapshot>>) {
    expectNoProviderMutation();
    const mutations = observedSql.filter((sql) =>
      /^\s*(?:INSERT|UPDATE|DELETE|MERGE|CALL|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql)
      || (/^\s*WITH\b/i.test(sql) && /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)));
    expect(mutations).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await pool.query(
      'SELECT id FROM admin_credential_bind_operations WHERE host_user_id = $1', [HOST],
    )).rows).toEqual([]);
    for (const table of ['users', 'identity_workos_users', 'authorization_epochs']) {
      expect((await pool.query(
        'SELECT workos_user_id FROM ' + table + ' WHERE workos_user_id = $1', [CREATED],
      )).rows).toEqual([]);
    }
  }

  async function expectCommittedActor(actorId: string) {
    expect(sdk.createUser).toHaveBeenCalledTimes(1);
    expect(sdk.deleteUser).not.toHaveBeenCalled();
    expect((await pool.query(
      'SELECT actor_user_id, actor_identity_id, status FROM admin_credential_bind_operations'
      + ' WHERE host_user_id = $1', [HOST],
    )).rows).toEqual([{
      actor_user_id: actorId, actor_identity_id: actorIdentityId, status: 'committed',
    }]);
    expect(await identityOf(CREATED)).toBe(hostIdentityId);
    expect((await pool.query(
      'SELECT workos_user_id FROM organization_memberships WHERE workos_user_id = $1', [CREATED],
    )).rows).toEqual([]);
    expect(sdk.createOrganizationMembership).not.toHaveBeenCalled();
    expect(sdk.updateOrganizationMembership).not.toHaveBeenCalled();
    expect(sdk.deleteOrganizationMembership).not.toHaveBeenCalled();
  }

  it('allows primary A through real middleware and records direct authenticated A', async () => {
    expect((await postAs(A)).status).toBe(201);
    expect(captured).toMatchObject({ id: A, authWorkosUserId: undefined });
    await expectCommittedActor(A);
  });

  it('denies linked nonadmin B although real middleware canonicalizes it to admin A', async () => {
    const before = await snapshot();
    const response = await postAs(B);
    expect(response.status).toBe(403);
    expect(captured).toMatchObject({ id: A, authWorkosUserId: B });
    await expectNoMutation(before);
  });

  it('allows B only with its own explicit membership and journals exact B', async () => {
    await grantAdmin(B);
    expect((await postAs(B)).status).toBe(201);
    expect(captured).toMatchObject({ id: A, authWorkosUserId: B });
    await expectCommittedActor(B);
  });

  it('does not inherit the primary admin email even when a session still reports it', async () => {
    process.env.ADMIN_EMAILS = A_EMAIL;
    const before = await snapshot();
    expect((await postAs(B, A_EMAIL)).status).toBe(403);
    await expectNoMutation(before);
  });

  it('allows break-glass only from the exact credential current database email', async () => {
    process.env.ADMIN_EMAILS = B_EMAIL;
    expect((await postAs(B)).status).toBe(201);
    expect(captured?.mechanism).toBe('break_glass_admin_email');
    await expectCommittedActor(B);
  });

  it('denies a formerly configured exact email after its database email changes', async () => {
    process.env.ADMIN_EMAILS = B_EMAIL;
    await pool.query('UPDATE users SET email = $1 WHERE workos_user_id = $2',
      ['jordan.changed@pinnacle.example', B]);
    const before = await snapshot();
    expect((await postAs(B, B_EMAIL)).status).toBe(403);
    await expectNoMutation(before);
  });

  it('returns unavailable for an exact membership lookup failure with no side effects', async () => {
    await grantAdmin(B); // Also reaches this local lookup after #7452 fixes the global gate.
    failExactMembershipLookup = true;
    const before = await snapshot();
    const response = await postAs(B);
    expect(membershipFailureInjected).toBe(true);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('admin_authorization_unavailable');
    await expectNoMutation(before);
  });
});
