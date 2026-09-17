/** Mounted authentication and lifecycle authorization must never consult grants. */
import express from 'express';
import request from 'supertest';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOSUser } from '../../src/types.js';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), loadSealedSession: vi.fn(), memberships: vi.fn(),
  verifyWorkOSJWT: vi.fn(), fetch: vi.fn(), checkPlatformBan: vi.fn(), createValidation: vi.fn(),
}));
vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    userManagement = {
      loadSealedSession: mocks.loadSealedSession,
      listOrganizationMemberships: mocks.memberships,
    };
    apiKeys = { createValidation: mocks.createValidation };
  },
}));
vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: { checkPlatformBan: mocks.checkPlatformBan, checkPlatformBanForApiKey: vi.fn() },
}));
vi.mock('../../src/auth/workos-jwt.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/auth/workos-jwt.js')>(),
  verifyWorkOSJWT: mocks.verifyWorkOSJWT,
}));

// Authentication, identity/epoch hydration, route authorization and its locks
// are real. Only remote authentication, membership and key transport are mocked.
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { invalidateBanCache, requireAuth, stopAuthTimers } from '../../src/middleware/auth.js';
import { createApiKeysRouter } from '../../src/routes/api-keys.js';

const PRIMARY = 'user_api_key_auth_primary';
const CREDENTIAL = 'user_api_key_auth_linked';
const ORGANIZATION = 'org_api_key_auth_pinnacle';
const PROVIDER_USER = {
  id: CREDENTIAL, email: 'sam@pinnacle.example', emailVerified: true,
  firstName: 'Sam', lastName: 'Adeyemi',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

let sequence = 0;

describe('API key management mounted authentication without grant storage', () => {
  let pool: Pool;
  let identityIds: string[] = [];
  let capturedUsers: WorkOSUser[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    // Explicit parsed cookies avoid introducing a separate cookie/CSRF harness.
    const cookie = req.headers.cookie;
    req.cookies = cookie?.startsWith('wos-session=')
      ? { 'wos-session': cookie.slice('wos-session='.length) } : {};
    res.on('finish', () => {
      if (req.user) capturedUsers.push(req.user);
    });
    next();
  });
  app.use('/api/me/api-keys', createApiKeysRouter());
  app.use('/dashboard-api-keys-control', createApiKeysRouter());
  app.get('/api/default-auth-control', requireAuth, (_req, res) => res.json({ allowed: true }));

  async function rawDelete(path: string, headers: Record<string, string>) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      return await new Promise<number | undefined>((resolve, reject) => {
        // Preserve the wire path: URL-aware clients normalize dot segments
        // before Express can decode and authorize the actual supplied ID.
        const req = httpRequest({
          hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
          method: 'DELETE', path, headers,
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  function credentialHeaders(kind: 'cookie' | 'JWT', token: string): Record<string, string> {
    return kind === 'cookie' ? { Cookie: `wos-session=${token}` } : { Authorization: `bEaReR\t${token}` };
  }

  function expectExactMembershipLookups(count: number) {
    expect(mocks.memberships.mock.calls).toEqual(Array.from({ length: count }, () => [{
      userId: CREDENTIAL, organizationId: ORGANIZATION,
    }]));
  }

  async function cleanup() {
    await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)', [[PRIMARY, CREDENTIAL]]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORGANIZATION]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[PRIMARY, CREDENTIAL]]);
    if (identityIds.length) {
      await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [identityIds]);
      identityIds = [];
    }
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    vi.stubGlobal('fetch', mocks.fetch);
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      stopAuthTimers();
      vi.unstubAllGlobals();
      await closeDatabase();
    }
  });

  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    capturedUsers = [];
    invalidateBanCache('user', CREDENTIAL);
    mocks.checkPlatformBan.mockResolvedValue({ banned: false });
    mocks.createValidation.mockResolvedValue({ apiKey: null });
    mocks.authenticate.mockResolvedValue({
      authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'access-token', organizationId: ORGANIZATION,
    });
    mocks.loadSealedSession.mockReturnValue({ authenticate: mocks.authenticate });
    mocks.verifyWorkOSJWT.mockResolvedValue({
      sub: CREDENTIAL, email: PROVIDER_USER.email, isM2M: false, orgId: ORGANIZATION,
    });
    mocks.memberships.mockImplementation(async ({ userId, organizationId }) => ({
      data: [{ id: `mem_${userId}`, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), userId, organizationId, status: 'active', role: { slug: 'admin' } }],
    }));
    mocks.fetch.mockImplementation(async (_url, options: RequestInit) => ({
      ok: true, status: options.method === 'DELETE' ? 204 : 200,
      json: async () => ({ data: [] }),
    }));
    await pool.query(
      'INSERT INTO organizations (workos_organization_id, name) VALUES ($1, $2)',
      [ORGANIZATION, 'Pinnacle Agency'],
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id)
       VALUES ($1, $2, $3), ($4, $5, $3)`,
      [PRIMARY, 'sam-primary@pinnacle.example', ORGANIZATION, CREDENTIAL, PROVIDER_USER.email],
    );
    const bindings = await pool.query(
      'SELECT workos_user_id, identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)',
      [[PRIMARY, CREDENTIAL]],
    );
    identityIds = bindings.rows.map((row) => row.identity_id);
    const primaryIdentity = bindings.rows.find((row) => row.workos_user_id === PRIMARY).identity_id;
    await pool.query(
      'UPDATE identity_workos_users SET identity_id = $1, is_primary = FALSE WHERE workos_user_id = $2',
      [primaryIdentity, CREDENTIAL],
    );
    await pool.query(
      `INSERT INTO organization_credential_grants
       (workos_user_id, workos_organization_id, role, granted_by_workos_user_id)
       VALUES ($1, $2, 'owner', $3)`, [CREDENTIAL, ORGANIZATION, PRIMARY],
    );
  });

  it.each(['cookie', 'JWT'] as const)('denies terminal lifecycle states before effects for cold and warm %s credentials', async (kind) => {
    for (const state of ['identity_credential_deleted', 'identity_primary_deletion_quarantined', 'missing binding', 'missing primary']) {
      for (const warm of [false, true]) {
        const token = kind === 'cookie' ? `sealed-lifecycle-${++sequence}` : `header.lifecycle${++sequence}.signature`;
        const headers = credentialHeaders(kind, token);
        if (warm) {
          expect((await request(app).get(`/api/me/api-keys?org=${ORGANIZATION}`).set(headers)).status).toBe(200);
        }
        if (state === 'missing binding') {
          await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id = $1', [CREDENTIAL]);
        } else if (state === 'missing primary') {
          await pool.query('UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1', [PRIMARY]);
        } else {
          await pool.query(
            `INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id)
             VALUES ($1, $2::text, $3, 'user', $2::text)`, [ORGANIZATION, CREDENTIAL, state],
          );
        }
        vi.clearAllMocks();
        capturedUsers = [];
        const listed = await request(app).get(`/api/me/api-keys?org=${ORGANIZATION}`).set(headers);
        const created = await request(app).post(`/api/me/api-keys?org=${ORGANIZATION}`).set(headers).send({ name: 'Scoped key' });
        const revoked = await request(app).delete(`/api/me/api-keys/key_exact?org=${ORGANIZATION}`).set(headers);
        expect([listed.status, created.status, revoked.status]).toEqual([401, 401, 401]);
        expect(mocks.memberships).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(capturedUsers).toEqual([]);
        await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = $1', [CREDENTIAL]);
        await pool.query('UPDATE identity_workos_users SET is_primary = TRUE WHERE workos_user_id = $1', [PRIMARY]);
        if (state === 'missing binding') {
          await pool.query(
            `INSERT INTO identity_workos_users (identity_id, workos_user_id, is_primary)
             SELECT identity_id, $2, FALSE FROM identity_workos_users WHERE workos_user_id = $1`, [PRIMARY, CREDENTIAL],
          );
        }
      }
    }
  });

  it.each(['identity_credential_deleted', 'identity_primary_deletion_quarantined'])(
    'retains %s denial after stale provider recreation of a warm credential', async action => {
      const headers = credentialHeaders('cookie', `sealed-recreation-${++sequence}`);
      expect((await request(app).get(`/api/me/api-keys?org=${ORGANIZATION}`).set(headers)).status).toBe(200);
      await pool.query(
        `INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id)
         VALUES ($1, $2::text, $3, 'user', $2::text)`, [ORGANIZATION, CREDENTIAL, action],
      );
      await pool.query('DELETE FROM users WHERE workos_user_id = $1', [CREDENTIAL]);
      await pool.query('INSERT INTO users (workos_user_id, email) VALUES ($1, $2)', [CREDENTIAL, PROVIDER_USER.email]);
      const recreated = await pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1', [CREDENTIAL]);
      identityIds.push(recreated.rows[0].identity_id);
      vi.clearAllMocks();
      expect((await request(app).get(`/api/me/api-keys?org=${ORGANIZATION}`).set(headers)).status).toBe(401);
      expect(mocks.authenticate).not.toHaveBeenCalled();
      expect(mocks.memberships).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['cookie', 'JWT'] as const)('permits cold and warm %s listing and contains mutations while grant storage is inaccessible', async (kind) => {
    const token = kind === 'cookie' ? `sealed-management-${++sequence}` : `header.management${++sequence}.signature`;
    const authenticate = (req: request.Test) => kind === 'cookie'
      ? req.set('Cookie', `wos-session=${token}`) : req.set('Authorization', `Bearer ${token}`);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE organization_credential_grants IN ACCESS EXCLUSIVE MODE');
      for (const _cacheState of ['cold', 'warm']) {
        const listed = await authenticate(request(app).get(`/api/me/api-keys?org=${ORGANIZATION}`));
        const created = await authenticate(request(app).post(`/api/me/api-keys?org=${ORGANIZATION}`)).send({ name: 'Scoped key' });
        const revoked = await authenticate(request(app).delete(`/api/me/api-keys/key_exact?org=${ORGANIZATION}`));
        expect([listed.status, created.status, revoked.status]).toEqual([200, 503, 503]);
      }
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(mocks.memberships.mock.calls.every(([selection]) =>
        selection.userId === CREDENTIAL && selection.organizationId === ORGANIZATION,
      )).toBe(true);
      expect(capturedUsers).toHaveLength(6);
      expect(new Set(capturedUsers).size).toBe(6);
      for (const user of capturedUsers) {
        expect(user.id).toBe(PRIMARY);
        expect(user.authWorkosUserId).toBe(CREDENTIAL);
        expect(user.authorizationSnapshot?.credentialGrant).toBeNull();
        expect(user.authorizationSnapshot?.authenticatedUserId).toBe(CREDENTIAL);
      }
      if (kind === 'cookie') expect(mocks.authenticate).toHaveBeenCalledOnce();
      else expect(mocks.verifyWorkOSJWT).toHaveBeenCalledOnce();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it.each([
    ['invalid API key', 'bEaReR\tsk_invalid'],
    ['revoked API key', 'BEARER  wos_api_key_revoked'],
    ['invalid JWT', 'Bearer header.invalid.signature'],
  ])('keeps %s terminal despite a valid attached cookie', async (_kind, authorization) => {
    mocks.verifyWorkOSJWT.mockRejectedValue(Object.assign(new Error('Invalid JWT signature'), {
      code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    }));
    const authenticate = (req: request.Test) => req
      .set('Authorization', authorization).set('Cookie', `wos-session=valid-management-${++sequence}`);
    const listed = await authenticate(request(app).get(`/api/me/api-keys?org=${ORGANIZATION}`));
    const created = await authenticate(request(app).post(`/api/me/api-keys?org=${ORGANIZATION}`)).send({ name: 'Scoped key' });
    const revoked = await authenticate(request(app).delete(`/api/me/api-keys/key_exact?org=${ORGANIZATION}`));
    expect([listed.status, created.status, revoked.status]).toEqual([401, 401, 401]);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.memberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(capturedUsers).toEqual([]);
  });

  it.each(['cookie', 'JWT'] as const)('authorizes exact cold/warm %s credentials before rejecting non-opaque wire IDs', async (kind) => {
    const token = kind === 'cookie' ? `sealed-path-${++sequence}` : `header.path${++sequence}.signature`;
    const headers = credentialHeaders(kind, token);
    const keyPaths = [
      '.', '..', '%2e', '%2E%2e', '.%2E', '%2e./',
      '%2e%2e%2fkey_other', '..%5Ckey_other', 'key_%2f..%2fkey_other',
      '%252e%252e%252fkey_other', '%255c', 'key_%25',
      '%2F%2Fexample.test', 'https%3A%2F%2Fexample.test',
      'key_value%3Fother=value', 'key_value%23fragment',
      'key_value%00', 'key_value%09', 'key_value%0A', 'key_value%0D',
      'key_value%EF%BC%8Fother',
    ];
    for (const keyPath of keyPaths) {
      mocks.memberships.mockClear();
      expect(await rawDelete(`/API/ME/API-KEYS/${keyPath}?org=${ORGANIZATION}`, headers)).toBe(400);
      expectExactMembershipLookups(2);
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
    expect(capturedUsers).toHaveLength(keyPaths.length);
    for (const user of capturedUsers) {
      expect(user.id).toBe(PRIMARY);
      expect(user.authWorkosUserId).toBe(CREDENTIAL);
      expect(user.authorizationSnapshot?.credentialGrant).toBeNull();
    }
    if (kind === 'cookie') expect(mocks.authenticate).toHaveBeenCalledOnce();
    else expect(mocks.verifyWorkOSJWT).toHaveBeenCalledOnce();
  });

  it.each([
    ['/api/me/api-keys', 'application/json', 401],
    ['/api/me/api-keys', 'text/html', 401],
    ['/dashboard-api-keys-control', 'text/html', 302],
  ] as const)('terminates credential absence for %s accepting %s before management hydration or effects', async (prefix, accept, status) => {
    const path = `${prefix}?org=${ORGANIZATION}`;
    for (const method of ['get', 'post'] as const) {
      const response = await request(app)[method](path).set('Accept', accept).send({ name: 'Scoped key' });
      expect(response.status).toBe(status);
      if (status === 302) {
        expect(response.headers.location).toBe(`/auth/login?return_to=${encodeURIComponent(path)}`);
      } else {
        expect(response.body.error).toBe('Authentication required');
      }
    }
    expect(await rawDelete(`${prefix}/%2E%2E?org=${ORGANIZATION}`, { Accept: accept })).toBe(status);
    expect(capturedUsers).toEqual([]);
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.verifyWorkOSJWT).not.toHaveBeenCalled();
    expect(mocks.createValidation).not.toHaveBeenCalled();
    expect(mocks.memberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['cookie', 'JWT'] as const)('rejects non-opaque %s organization selectors before management lookups or effects', async (kind) => {
    for (const organizationId of ['.', '..', '%2e%2e', 'org_target/other', 'org_target\\other',
      'org_target?other=value', 'org_target#fragment', 'org_target\u0000', 'org_target\t', 'org_target\uff0fother']) {
      // Let the real authentication selection agree, so the route must enforce
      // its own opaque-segment boundary rather than relying on a conflict.
      mocks.authenticate.mockResolvedValue({
        authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'access-token', organizationId,
      });
      mocks.verifyWorkOSJWT.mockResolvedValue({
        sub: CREDENTIAL, email: PROVIDER_USER.email, isM2M: false, orgId: organizationId,
      });
      const token = kind === 'cookie' ? `sealed-org-path-${++sequence}` : `header.orgpath${++sequence}.signature`;
      const headers = credentialHeaders(kind, token);
      const path = `/api/me/api-keys?org=${encodeURIComponent(organizationId)}`;
      const listed = await request(app).get(path).set(headers);
      const created = await request(app).post(path).set(headers).send({ name: 'Scoped key' });
      const revoked = await rawDelete(`/api/me/api-keys/key_exact?org=${encodeURIComponent(organizationId)}`, headers);
      expect([listed.status, created.status, revoked]).toEqual([400, 400, 400]);
      expect(mocks.memberships).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  });

  it.each(['cookie', 'JWT'] as const)('preserves exact %s denial and uncertainty before non-opaque ID rejection', async (kind) => {
    const token = kind === 'cookie' ? `sealed-path-denial-${++sequence}` : `header.pathdenial${++sequence}.signature`;
    const headers = credentialHeaders(kind, token);
    mocks.memberships.mockResolvedValueOnce({ data: [] });
    expect(await rawDelete(`/api/me/api-keys/%2e%2e%2fkey_other?org=${ORGANIZATION}`, headers)).toBe(403);
    expectExactMembershipLookups(1);
    mocks.memberships.mockClear();
    mocks.memberships.mockRejectedValueOnce(new Error('Membership provider unavailable'));
    expect(await rawDelete(`/api/me/api-keys/%2e%2e%2fkey_other?org=${ORGANIZATION}`, headers)).toBe(503);
    expectExactMembershipLookups(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['cookie', 'JWT'] as const)('lists the fixed organization subresource for %s but never dispatches accepted mutations', async (kind) => {
    const token = kind === 'cookie' ? `sealed-path-control-${++sequence}` : `header.pathcontrol${++sequence}.signature`;
    const headers = credentialHeaders(kind, token);
    const listed = await request(app).get(`/api/me/api-keys?org=${ORGANIZATION}`).set(headers);
    expect(listed.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(new URL(url).origin).toBe('https://api.workos.com');
    expect(new URL(url).pathname).toBe(`/organizations/${ORGANIZATION}/api_keys`);
    expect(options.method).toBe('GET');
    mocks.fetch.mockClear();
    const created = await request(app).post(`/api/me/api-keys?org=${ORGANIZATION}`)
      .set(headers).send({ name: 'Scoped key' });
    expect(created.status).toBe(503);
    for (const keyPath of ['api_key_01AZaz09_-', '%6bey_valid/']) {
      expect(await rawDelete(`/api/me/api-keys/${keyPath}?org=${ORGANIZATION}`, headers)).toBe(503);
    }
    expectExactMembershipLookups(9);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps grant-bearing default authentication separate from the management route policy', async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE organization_credential_grants IN ACCESS EXCLUSIVE MODE');
      const response = await request(app).get(`/api/default-auth-control?org=${ORGANIZATION}`)
        .set('Cookie', `wos-session=default-management-control-${++sequence}`);
      expect(response.status).toBe(503);
      expect(mocks.memberships).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});
