/** Real mounted authentication, snapshot SQL and org resolution; only WorkOS is mocked. */
import express, { type Request } from 'express';
import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import request, { type Test } from 'supertest';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), refresh: vi.fn(), loadSealedSession: vi.fn(),
  memberships: vi.fn(), validateApiKey: vi.fn(),
}));
vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      loadSealedSession: mocks.loadSealedSession,
      listOrganizationMemberships: mocks.memberships,
    };
    apiKeys = { createValidation: mocks.validateApiKey };
  },
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import * as database from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { bumpAuthorizationEpochs } from '../../src/db/authorization-epoch-db.js';
import { invalidateSessionCache, optionalAuth, requireAuth, stopAuthTimers } from '../../src/middleware/auth.js';
import { resolveCallerOrgId, sendCallerOrganizationAuthError } from '../../src/routes/helpers/resolve-caller-org.js';
import { buildConformanceTokenRouter } from '../../src/conformance/token-route.js';
import { verifyConformanceToken } from '../../src/conformance/token.js';

const PRIMARY = 'user_sealed_bearer_primary';
const EXACT = 'user_sealed_bearer_exact';
const ORG = 'org_sealed_bearer_pinnacle';
const OTHER = 'org_sealed_bearer_streamhaus';
const PROVIDER_USER = {
  id: EXACT, email: 'sam@streamhaus.example', firstName: 'Sam', lastName: 'Adeyemi',
  emailVerified: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};
let pool: Pool;
let identities: string[] = [];
let sequence = 0;
const tokenPrefix = randomUUID();
const tokens: string[] = [];
function token() {
  const value = `sealed-native-${tokenPrefix}-${++sequence}`;
  tokens.push(value);
  return value;
}
function membership(userId = EXACT, organizationId = ORG, status = 'active') {
  return { userId, organizationId, status, role: { slug: 'member' } };
}

async function cleanup() {
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [[PRIMARY, EXACT]]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [[ORG, OTHER]]);
  await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[PRIMARY, EXACT]]);
  await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [identities]);
  identities = [];
}

beforeAll(async () => {
  pool = initializeDatabase({
    connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
  });
  await runMigrations();
}, 60000);

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const value of tokens.splice(0)) invalidateSessionCache(value);
  await cleanup();
  mocks.authenticate.mockReset().mockResolvedValue({
    authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'native-access-token',
  });
  mocks.refresh.mockReset().mockResolvedValue({ authenticated: false, reason: 'invalid_grant', retryable: false });
  mocks.loadSealedSession.mockReset().mockReturnValue({ authenticate: mocks.authenticate, refresh: mocks.refresh });
  mocks.memberships.mockReset().mockResolvedValue({ data: [] });
  mocks.validateApiKey.mockReset().mockResolvedValue(null);
  await pool.query(
    'INSERT INTO organizations (workos_organization_id, name) VALUES ($1, $2), ($3, $4)',
    [ORG, 'Pinnacle Agency', OTHER, 'StreamHaus'],
  );
  // Both credentials have a tempting primary org, even when no memberships exist.
  await pool.query(
    `INSERT INTO users (workos_user_id, email, primary_organization_id, email_verified)
     VALUES ($1, $2, $3, true), ($4, $5, $3, true)`,
    [PRIMARY, 'sam@pinnacle.example', ORG, EXACT, PROVIDER_USER.email],
  );
  const bindings = await pool.query(
    'SELECT workos_user_id, identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [[PRIMARY, EXACT]],
  );
  identities = bindings.rows.map(row => row.identity_id);
  await pool.query(
    'UPDATE identity_workos_users SET identity_id = $1, is_primary = FALSE WHERE workos_user_id = $2',
    [bindings.rows.find(row => row.workos_user_id === PRIMARY).identity_id, EXACT],
  );
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  stopAuthTimers();
  try { if (pool) await cleanup(); } finally { await closeDatabase(); }
});

async function grant(state = 'valid', userId = EXACT, organizationId = ORG) {
  const result = await pool.query(
    `INSERT INTO organization_credential_grants
      (workos_user_id, workos_organization_id, role, granted_by_workos_user_id,
       effective_from, effective_until, revoked_at, revoked_by_workos_user_id)
     VALUES ($1, $2, 'member', $3, $4, $5,
       CASE WHEN $6 THEN NOW() ELSE NULL END,
       CASE WHEN $6 THEN $3::varchar ELSE NULL END) RETURNING id`,
    [userId, organizationId, PRIMARY,
      state === 'future' ? '2999-01-01' : '2000-01-01',
      state === 'expired' ? '2001-01-01' : null, state === 'revoked'],
  );
  return result.rows[0].id as string;
}

type Mode = 'required' | 'optional';
function mount(mode: Mode, beforeResolve?: (req: Request) => void | Promise<void>) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(mode === 'required' ? requireAuth : optionalAuth);
  const reached: Request[] = [];
  const handler = async (req: Request, res: express.Response, next: express.NextFunction) => {
    reached.push(req);
    try {
      await beforeResolve?.(req);
      const organizationId = await resolveCallerOrgId(req);
      res.status(organizationId ? 200 : 403).json({ organizationId });
    } catch (err) { next(err); }
  };
  app.post('/scope', handler);
  // These params are intentionally populated AFTER authentication.
  for (const field of ['org_id', 'orgId', 'organizationId']) app.post(`/${field}/:${field}/scope`, handler);
  app.use((err: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    if (!sendCallerOrganizationAuthError(err, res)) res.status(500).json({ error: 'unexpected_test_error' });
  });
  return { app, reached };
}
type Mounted = ReturnType<typeof mount>;
function post(mounted: Mounted, value: string, path = '/scope') {
  return request(mounted.app).post(path).set('Authorization', `Bearer ${value}`);
}
function expectProvenance(req: Request) {
  expect(req.authenticatedSealedBearer?.authorizationSnapshot).toBe(req.user?.authorizationSnapshot);
  expect(req.user?.authorizationSnapshot).toMatchObject({ authenticatedUserId: EXACT, canonicalUserId: PRIMARY });
  expect(req.user?.authWorkosUserId).toBe(EXACT);
  expect(Object.keys(req)).not.toContain('authenticatedSealedBearer');
  expect(Object.isFrozen(req.authenticatedSealedBearer)).toBe(true);
  expect({ ...req.user }).not.toHaveProperty('authorizationSnapshot');
}

const selectors: Array<[string, string, (pending: Test, org: string) => Test]> = [
  ['header', '/scope', (pending, org) => pending.set('X-Organization-Id', org)],
  ...['org', 'org_id', 'organization_id', 'organizationId'].map(field =>
    [`query ${field}`, '/scope', (pending: Test, org: string) => pending.query({ [field]: org })] as [string, string, (pending: Test, org: string) => Test]),
  ...['org_id', 'organization_id', 'organizationId'].map(field =>
    [`body ${field}`, '/scope', (pending: Test, org: string) => pending.send({ [field]: org })] as [string, string, (pending: Test, org: string) => Test]),
  ...['org_id', 'orgId', 'organizationId'].map(field =>
    [`path ${field}`, `/${field}/${ORG}/scope`, (pending: Test) => pending] as [string, string, (pending: Test, org: string) => Test]),
];

describe.each(['required', 'optional'] as const)('%s native sealed bearer', mode => {
  describe.each(['miss', 'hit'] as const)('cache %s', cache => {
    async function prepare(beforeResolve?: (req: Request) => void | Promise<void>) {
      const mounted = mount(mode, beforeResolve);
      const value = token();
      if (cache === 'hit') {
        expect((await post(mount(mode), value)).status).toBe(403);
        mocks.memberships.mockClear();
      }
      return { mounted, value };
    }

    it.each([0, 1, 2])('leaves organization null with %i orgs and no selector', async count => {
      for (const organizationId of [ORG, OTHER].slice(0, count)) {
        await pool.query(
          `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
           VALUES ($1, $2, $3, 'owner')`, [EXACT, organizationId, PROVIDER_USER.email],
        );
        await grant('valid', EXACT, organizationId);
      }
      mocks.memberships.mockResolvedValue({ data: [ORG, OTHER].slice(0, count).map(org => membership(EXACT, org)) });
      const { mounted, value } = await prepare();
      const response = await post(mounted, value);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ organizationId: null });
      expectProvenance(mounted.reached[0]);
      expect(mounted.reached[0].user?.authorizationSnapshot?.selectedOrganizationId).toBeNull();
      expect(mocks.memberships).not.toHaveBeenCalled();
      expect(mocks.validateApiKey).not.toHaveBeenCalled();
      expect(mocks.authenticate).toHaveBeenCalledOnce();
    });

    it.each(selectors)('authorizes exact direct membership selected by %s', async (_name, path, select) => {
      mocks.memberships.mockResolvedValue({ data: [membership()] });
      const { mounted, value } = await prepare();
      const response = await select(post(mounted, value, path), ORG);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ organizationId: ORG });
      expectProvenance(mounted.reached[0]);
      expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith({ userId: EXACT, organizationId: ORG });
      expect(mocks.authenticate).toHaveBeenCalledOnce();
      expect(mocks.validateApiKey).not.toHaveBeenCalled();
    });

    it.each(['absent', 'unavailable'])('authorizes a valid grant with %s direct membership', async state => {
      await grant();
      if (state === 'unavailable') mocks.memberships.mockRejectedValue(new Error('WorkOS unavailable'));
      const { mounted, value } = await prepare();
      expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(200);
      expectProvenance(mounted.reached[0]);
      expect(mounted.reached[0].user?.authorizationSnapshot?.credentialGrant?.organizationId).toBe(ORG);
      expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith({ userId: EXACT, organizationId: ORG });
    });

    it.each(['missing', 'expired', 'future', 'revoked', 'other org', 'canonical sibling', 'inactive membership'])('denies %s authority', async state => {
      if (['expired', 'future', 'revoked'].includes(state)) await grant(state);
      if (state === 'other org') await grant('valid', EXACT, OTHER);
      if (state === 'canonical sibling') {
        await grant('valid', PRIMARY);
        mocks.memberships.mockResolvedValue({ data: [membership(PRIMARY)] });
      }
      if (state === 'inactive membership') mocks.memberships.mockResolvedValue({ data: [membership(EXACT, ORG, 'inactive')] });
      const { mounted, value } = await prepare();
      const response = await post(mounted, value).set('X-Organization-Id', ORG);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ organizationId: null });
      expect(mounted.reached[0].user?.authorizationSnapshot?.credentialGrant).toBeNull();
      expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith({ userId: EXACT, organizationId: ORG });
    });

    it.each(selectors)('denies mismatched %s selection before provider membership reads', async (_name, path, select) => {
      mocks.authenticate.mockResolvedValue({
        authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'native-access-token', organizationId: OTHER,
      });
      const mounted = mount(mode);
      const value = token();
      if (cache === 'hit') expect((await post(mounted, value)).status).toBe(403);
      mocks.memberships.mockClear();
      const response = await select(post(mounted, value, path), ORG);
      expect(response.status).toBe(403);
      expect(mocks.memberships).not.toHaveBeenCalled();
      expect(mocks.authenticate).toHaveBeenCalledOnce();
    });

    it.each(['epoch', 'grant revocation', 'database unavailable'])('denies %s between middleware and resolver without provider reads', async state => {
      const id = await grant();
      const { mounted, value } = await prepare(async () => {
        if (state === 'epoch') await bumpAuthorizationEpochs(pool, [EXACT]);
        if (state === 'grant revocation') await pool.query(
          'UPDATE organization_credential_grants SET revoked_at = NOW(), revoked_by_workos_user_id = $2 WHERE id = $1', [id, PRIMARY],
        );
        if (state === 'database unavailable') vi.spyOn(database, 'queryWithTimeout').mockRejectedValue(new Error('private database outage'));
      });
      const response = await post(mounted, value).set('X-Organization-Id', ORG);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ organizationId: null });
      expect(mocks.memberships).not.toHaveBeenCalled();
    });

    it('returns 503 before the handler when snapshot hydration is unavailable', async () => {
      const { mounted, value } = await prepare();
      vi.spyOn(database, 'queryWithTimeout').mockRejectedValue(new Error('private database outage'));
      const response = await post(mounted, value).set('X-Organization-Id', ORG);
      expect(response.status).toBe(503);
      expect(mounted.reached).toHaveLength(0);
      expect(mocks.memberships).not.toHaveBeenCalled();
      expect(response.text).not.toContain('private');
    });

    it('denies unavailable membership without a grant instead of selecting a primary org', async () => {
      mocks.memberships.mockRejectedValue(new Error('private provider outage'));
      const { mounted, value } = await prepare();
      const response = await post(mounted, value).set('X-Organization-Id', ORG);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ organizationId: null });
    });

    it('denies a missing exact credential even when its canonical sibling remains', async () => {
      const { mounted, value } = await prepare();
      await pool.query('DELETE FROM users WHERE workos_user_id = $1', [EXACT]);
      expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(401);
      expect(mounted.reached).toHaveLength(0);
      expect(mocks.memberships).not.toHaveBeenCalled();
    });
  });

  it.each(['invalid', 'revoked'])('rejects an %s opaque bearer and dead-cache replay without using a valid cookie', async state => {
    const mounted = mount(mode);
    const validCookie = token();
    expect((await request(mounted.app).post('/scope').set('Cookie', `wos-session=${validCookie}`)).status).toBe(403);
    mounted.reached.length = 0;
    mocks.authenticate.mockClear().mockResolvedValue({ authenticated: false, reason: state === 'revoked' ? 'invalid_grant' : 'invalid_session' });
    const invalid = token();
    for (let i = 0; i < 2; i++) {
      const response = await post(mounted, invalid).set('Cookie', `wos-session=${validCookie}`).set('X-Organization-Id', ORG)
        .set('authenticatedSealedBearer', 'true').send({ authenticatedSealedBearer: { tokenHash: invalid } });
      expect(response.status).toBe(401);
    }
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect(mounted.reached).toHaveLength(0);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('rejects a previously cached bearer after provider revocation and cache invalidation', async () => {
    mocks.memberships.mockResolvedValue({ data: [membership()] });
    const mounted = mount(mode);
    const value = token();
    expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(200);
    invalidateSessionCache(value);
    mocks.authenticate.mockResolvedValue({ authenticated: false, reason: 'invalid_grant' });
    mocks.memberships.mockClear();
    expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(401);
    expect(mounted.reached).toHaveLength(1);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it.each(['token', 'snapshot', 'principal'])('rejects a replaced %s after middleware authentication', async state => {
    const mounted = mount(mode, req => {
      if (state === 'token') req.headers.authorization = 'Bearer different-invalid-token';
      if (state === 'snapshot') req.user = { ...req.user! };
      if (state === 'principal') req.user!.authWorkosUserId = PRIMARY;
    });
    const response = await post(mounted, token()).set('X-Organization-Id', ORG);
    expect(response.status).toBe(state === 'principal' ? 403 : 401);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('does not trust an opaque bearer added to an authenticated cookie request without provenance', async () => {
    await grant();
    const mounted = mount(mode, req => { req.headers.authorization = 'Bearer unauthenticated-opaque'; });
    const response = await request(mounted.app).post('/scope')
      .set('Cookie', `wos-session=${token()}`).set('X-Organization-Id', ORG);
    expect(response.status).toBe(401);
    expect(mounted.reached[0].user?.authorizationSnapshot?.credentialGrant).not.toBeNull();
    expect(mounted.reached[0].authenticatedSealedBearer).toBeUndefined();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it.each(['', null, [], {}])('rejects malformed explicit selector %j without provider membership reads', async selector => {
    const mounted = mount(mode);
    expect((await post(mounted, token()).send({ organization_id: selector })).status).toBe(403);
    expect(mounted.reached).toHaveLength(0);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('returns 503 on provider authentication outage without reaching organization resolution', async () => {
    mocks.authenticate.mockRejectedValue(Object.assign(new Error('private provider outage'), { code: 'ETIMEDOUT' }));
    const mounted = mount(mode);
    const response = await post(mounted, token()).set('X-Organization-Id', ORG);
    expect(response.status).toBe(503);
    expect(mounted.reached).toHaveLength(0);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('keeps overlapping cache hits bound to independent explicit selections', async () => {
    const mounted = mount(mode);
    const value = token();
    expect((await post(mounted, value)).status).toBe(403);
    mocks.memberships.mockImplementation(async ({ organizationId }) => ({ data: [membership(EXACT, organizationId)] }));
    const responses = await Promise.all([ORG, OTHER].map(org => post(mounted, value).set('X-Organization-Id', org)));
    expect(responses.map(response => response.body.organizationId)).toEqual([ORG, OTHER]);
    const requests = mounted.reached.slice(1);
    requests.forEach(expectProvenance);
    expect(new Set(requests.map(req => req.user?.authorizationSnapshot?.selectedOrganizationId))).toEqual(new Set([ORG, OTHER]));
    expect(requests[0].authenticatedSealedBearer).not.toBe(requests[1].authenticatedSealedBearer);
    expect(mocks.authenticate).toHaveBeenCalledOnce();
  });

  it('rehydrates a fresh snapshot and selection on every cache hit without retaining handler mutation', async () => {
    mocks.memberships.mockResolvedValue({ data: [membership(), membership(EXACT, OTHER)] });
    const mounted = mount(mode);
    const value = token();
    expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(200);
    const first = mounted.reached[0];
    first.user!.id = 'user_mutated_by_handler';
    first.user!.authWorkosUserId = 'user_mutated_credential';
    await bumpAuthorizationEpochs(pool, [EXACT]);
    expect((await post(mounted, value).set('X-Organization-Id', OTHER)).status).toBe(200);
    expect((await post(mounted, value)).body).toEqual({ organizationId: null });
    const second = mounted.reached[1];
    expectProvenance(second);
    expect(second.user?.authorizationSnapshot?.authorizationEpoch).toBe('1');
    expect(second.authenticatedSealedBearer).not.toBe(first.authenticatedSealedBearer);
    expect(second.user?.authorizationSnapshot).not.toBe(first.user?.authorizationSnapshot);
    expect(mocks.authenticate).toHaveBeenCalledOnce();
  });

  it('does not reuse a cached grant after committed revocation', async () => {
    const id = await grant();
    const mounted = mount(mode);
    const value = token();
    expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(200);
    await pool.query(
      'UPDATE organization_credential_grants SET revoked_at = NOW(), revoked_by_workos_user_id = $2 WHERE id = $1', [id, PRIMARY],
    );
    expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(403);
    expect(mounted.reached[1].user?.authorizationSnapshot?.credentialGrant).toBeNull();
    expect(mocks.authenticate).toHaveBeenCalledOnce();
  });

  it('rejects an epoch change during the provider membership read', async () => {
    mocks.memberships.mockImplementation(async () => {
      await bumpAuthorizationEpochs(pool, [EXACT]);
      return { data: [membership()] };
    });
    expect((await post(mount(mode), token()).set('X-Organization-Id', ORG)).status).toBe(403);
  });

  it('preserves successful refresh provenance on the initial request and cache hit', async () => {
    mocks.authenticate.mockResolvedValueOnce({ authenticated: false });
    mocks.refresh.mockResolvedValueOnce({ authenticated: true, sealedSession: token() });
    mocks.memberships.mockResolvedValue({ data: [membership()] });
    const mounted = mount(mode);
    const value = token();
    for (let i = 0; i < 2; i++) expect((await post(mounted, value).set('X-Organization-Id', ORG)).status).toBe(200);
    mounted.reached.forEach(expectProvenance);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});

describe('shared sealed-session cache transport isolation', () => {
  it.each(['required', 'optional'] as const)('keeps provenance local when %s auth seeds the cache', async mode => {
    mocks.memberships.mockResolvedValue({ data: [membership()] });
    const first = mount(mode);
    const second = mount(mode === 'required' ? 'optional' : 'required');
    const value = token();
    const cookie = (mounted: Mounted) => request(mounted.app).post('/scope').set('Cookie', `wos-session=${value}`);
    expect((await cookie(first).set('X-Organization-Id', ORG)).status).toBe(200);
    expect(first.reached[0].authenticatedSealedBearer).toBeUndefined();
    expect((await post(second, value).set('X-Organization-Id', ORG)).status).toBe(200);
    expectProvenance(second.reached[0]);
    expect((await cookie(first)).body).toEqual({ organizationId: null });
    expect(first.reached[1].authenticatedSealedBearer).toBeUndefined();
    expect(mocks.authenticate).toHaveBeenCalledOnce();
  });

  it('issues an org-bound conformance token through the real required-auth consumer', async () => {
    vi.stubEnv('CONFORMANCE_JWT_SECRET', 'sealed-bearer-conformance-test-secret');
    await grant();
    const app = express();
    app.use(cookieParser(), express.json());
    app.use('/api/conformance', buildConformanceTokenRouter());
    const value = token();
    for (let i = 0; i < 2; i++) {
      const response = await request(app).post('/api/conformance/token')
        .set('Authorization', `bEaReR\t ${value}`).send({ organization_id: ORG });
      expect(response.status).toBe(200);
      expect(verifyConformanceToken(response.body.token).sub).toBe(ORG);
    }
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect((await request(app).post('/api/conformance/token').set('Authorization', `Bearer ${value}`)).status).toBe(403);
  });
});
