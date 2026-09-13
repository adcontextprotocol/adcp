/** Provider caches must never become identity, organization, or epoch authority. */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), loadSealedSession: vi.fn(), checkPlatformBan: vi.fn(),
  loadAuthorizationSnapshot: vi.fn(), verifyWorkOSJWT: vi.fn(), poolQuery: vi.fn(),
  refresh: vi.fn(), getRefreshedSession: vi.fn(),
}));
vi.hoisted(() => {
  process.env.DEV_USER_EMAIL = '';
  process.env.DEV_USER_ID = '';
  process.env.WORKOS_API_KEY ??= 'sk_test';
  process.env.WORKOS_CLIENT_ID ??= 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'placeholder-cookie-password-32-bytes-min';
});
vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return {
      userManagement: { loadSealedSession: mocks.loadSealedSession },
      apiKeys: { createValidation: vi.fn() },
    };
  }),
}));
vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: { checkPlatformBan: mocks.checkPlatformBan, checkPlatformBanForApiKey: vi.fn() },
}));
vi.mock('../../src/db/user-authorization-snapshot-db.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/user-authorization-snapshot-db.js')>(),
  loadAuthorizationSnapshot: mocks.loadAuthorizationSnapshot,
}));
vi.mock('../../src/auth/workos-jwt.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/auth/workos-jwt.js')>(),
  verifyWorkOSJWT: mocks.verifyWorkOSJWT,
  looksLikeJWT: (token: string) => token.split('.').length === 3,
}));
vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }), query: mocks.poolQuery, isDatabaseInitialized: () => true,
}));
vi.mock('../../src/db/session-refresh-db.js', () => ({
  getRefreshedSession: mocks.getRefreshedSession,
  storeRefreshedSession: vi.fn().mockResolvedValue(undefined),
  cleanExpiredRefreshes: vi.fn().mockResolvedValue(0),
}));
import { AuthorizationSnapshotUnavailableError } from '../../src/db/user-authorization-snapshot-db.js';
import { invalidateBanCache, optionalAuth, requireAuth, stopAuthTimers } from '../../src/middleware/auth.js';
import { csrfProtection } from '../../src/middleware/csrf.js';

const AUTHENTICATED_ID = 'user_epoch_authenticated';
const PROVIDER_USER = {
  id: AUTHENTICATED_ID, email: 'sam@example.test', firstName: 'Sam', lastName: 'Adeyemi',
  emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
let sequence = 0;
function snapshot(overrides: Partial<AuthorizationSnapshot> = {}): AuthorizationSnapshot {
  return {
    authenticatedUserId: AUTHENTICATED_ID, canonicalUserId: AUTHENTICATED_ID,
    identityId: 'identity_epoch', authorizationEpoch: '1', selectedOrganizationId: null,
    credential: { email: PROVIDER_USER.email, firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true },
    credentialGrant: null, ...overrides,
  };
}
function request(token: string, bearer = false): Request {
  return {
    headers: bearer ? { authorization: `Bearer ${token}` } : {},
    cookies: bearer ? {} : { 'wos-session': token }, query: {}, body: {}, params: {},
    path: '/api/me', originalUrl: '/api/me', accepts: () => false,
  } as unknown as Request;
}
function response(): Response {
  return {
    cookie: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
  } as unknown as Response;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAuthorizationSnapshot.mockReset();
  mocks.loadAuthorizationSnapshot.mockImplementation(async (_id: string, org: string | null) =>
    snapshot({ selectedOrganizationId: org }));
  invalidateBanCache('user', AUTHENTICATED_ID);
  mocks.checkPlatformBan.mockResolvedValue({ banned: false });
  mocks.authenticate.mockResolvedValue({ authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'access-token' });
  mocks.refresh.mockReset().mockResolvedValue({ authenticated: false });
  mocks.getRefreshedSession.mockReset().mockResolvedValue(null);
  mocks.loadSealedSession.mockReturnValue({ authenticate: mocks.authenticate, refresh: mocks.refresh });
  mocks.verifyWorkOSJWT.mockResolvedValue({ sub: AUTHENTICATED_ID, email: PROVIDER_USER.email, isM2M: false });
});

const organizationSelectors: Array<[string, (req: Request, organizationId: string) => void]> = [
  ['header', (req, org) => { req.headers['x-organization-id'] = org; }],
  ['query org', (req, org) => { req.query.org = org; }],
  ['query organization_id', (req, org) => { req.query.organization_id = org; }],
  ['query organizationId', (req, org) => { req.query.organizationId = org; }],
  ['body organization_id', (req, org) => { req.body.organization_id = org; }],
  ['body organizationId', (req, org) => { req.body.organizationId = org; }],
  ['path orgId', (req, org) => { req.params.orgId = org; }],
  ['path organizationId', (req, org) => { req.params.organizationId = org; }],
];

describe.each([
  ['required cookie', requireAuth, false], ['optional cookie', optionalAuth, false],
  ['required bearer', requireAuth, true], ['optional bearer', optionalAuth, true],
] as const)('%s provider organization binding', (_label, middleware, bearer) => {
  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'access-token', organizationId: 'org_pinnacle',
    });
    mocks.verifyWorkOSJWT.mockResolvedValue({
      sub: AUTHENTICATED_ID, email: PROVIDER_USER.email, isM2M: false, orgId: 'org_pinnacle',
    });
  });

  describe.each(['cold', 'warm'] as const)('%s cache', (cacheState) => {
    it.each(organizationSelectors)('rejects a mismatched %s selector and permits a matching selector', async (_location, select) => {
      for (const selectedOrg of ['org_streamhaus', 'org_pinnacle']) {
        const token = bearer ? `header.org${++sequence}.signature` : `sealed-org-${++sequence}`;
        if (cacheState === 'warm') await middleware(request(token, bearer), response(), vi.fn());
        const req = request(token, bearer);
        select(req, selectedOrg);
        const res = response();
        const next = vi.fn();
        const snapshotsBefore = mocks.loadAuthorizationSnapshot.mock.calls.length;
        await middleware(req, res, next);
        if (selectedOrg === 'org_streamhaus') {
          expect(res.status).toHaveBeenCalledWith(403);
          expect(next).not.toHaveBeenCalled();
          expect(req.user).toBeUndefined();
          expect(mocks.loadAuthorizationSnapshot).toHaveBeenCalledTimes(snapshotsBefore);
        } else {
          expect(next).toHaveBeenCalledOnce();
          expect(res.status).not.toHaveBeenCalled();
          expect(req.user?.authorizationSnapshot?.selectedOrganizationId).toBe('org_pinnacle');
        }
      }
    });
  });

  it.each(['', '   ', null, [], {}])('rejects malformed supplied provider organization %j', async (providerOrganization) => {
    mocks.authenticate.mockResolvedValue({
      authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'access-token', organizationId: providerOrganization,
    });
    mocks.verifyWorkOSJWT.mockResolvedValue({
      sub: AUTHENTICATED_ID, email: PROVIDER_USER.email, isM2M: false, orgId: providerOrganization,
    });
    const token = bearer ? `header.malformed${++sequence}.signature` : `sealed-malformed-${++sequence}`;
    const req = request(token, bearer);
    req.headers['x-organization-id'] = 'org_pinnacle';
    const res = response();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });
});

describe('optional authentication credential presence', () => {
  function expectRejected(req: Request, res: Response, next: ReturnType<typeof vi.fn>, status: number): void {
    expect(res.status).toHaveBeenCalledWith(status);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(res.redirect).not.toHaveBeenCalled();
  }

  it('permits anonymous access only when no credential is supplied', async () => {
    const req = request('unused');
    req.cookies = {};
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects a failed JWT without anonymous or cookie fallback (cookie present: %s)', async (cookiePresent) => {
    const req = request(`header.invalid${++sequence}.signature`, true);
    if (cookiePresent) req.cookies['wos-session'] = 'otherwise-valid-cookie';
    mocks.verifyWorkOSJWT.mockRejectedValue(Object.assign(new Error('Invalid JWT signature'), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' }));
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 401);
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it.each(['Bearer ', 'Bearer    ', 'Basic invalid', ''])('rejects malformed authorization header %j without cookie fallback', async (header) => {
    const req = request('otherwise-valid-cookie');
    req.headers.authorization = header;
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 401);
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized bearer after sealed-session validation instead of using a valid cookie', async () => {
    const token = `invalid-opaque-${++sequence}`;
    const req = request(token, true);
    req.cookies['wos-session'] = 'otherwise-valid-cookie';
    mocks.authenticate.mockResolvedValue({ authenticated: false });
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 401);
    expect(mocks.loadSealedSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionData: token }));
  });

  it('continues to authenticate native sealed bearer sessions', async () => {
    const token = `native-sealed-${++sequence}`;
    const req = request(token, true);
    const next = vi.fn();
    await optionalAuth(req, response(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.loadSealedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionData: token }));
    expect(req.user?.authorizationSnapshot?.authenticatedUserId).toBe(AUTHENTICATED_ID);
  });

  it.each(['', null, {}])('rejects malformed supplied session cookie %j', async (cookie) => {
    const req = request('unused');
    req.cookies['wos-session'] = cookie;
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 401);
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
  });

  it('rejects expired sessions and their dead-cache replay instead of making them anonymous', async () => {
    const token = `dead-session-${++sequence}`;
    mocks.authenticate.mockResolvedValue({ authenticated: false });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const req = request(token);
      const res = response();
      const next = vi.fn();
      await optionalAuth(req, res, next);
      expectRejected(req, res, next, 401);
    }
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('rejects a provider result claiming authentication without a user', async () => {
    mocks.authenticate.mockResolvedValue({ authenticated: true });
    const req = request(`missing-user-${++sequence}`);
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 401);
  });

  it.each([false, true])('rejects a missing local credential on cold authentication (bearer: %s)', async (bearer) => {
    mocks.loadAuthorizationSnapshot.mockResolvedValue(null);
    const req = request(bearer ? `header.missing${++sequence}.signature` : `sealed-missing-${++sequence}`, bearer);
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 401);
  });

  it.each(['JWT verification', 'session authentication', 'session refresh'] as const)('returns 503 on transient %s failure without anonymous fallback', async (stage) => {
    const transient = Object.assign(new Error('Authentication upstream timed out'), { code: 'ETIMEDOUT' });
    const bearer = stage === 'JWT verification';
    const req = request(bearer ? `header.timeout${++sequence}.signature` : `sealed-timeout-${++sequence}`, bearer);
    if (stage === 'JWT verification') mocks.verifyWorkOSJWT.mockRejectedValue(transient);
    if (stage === 'session authentication') mocks.authenticate.mockRejectedValue(transient);
    if (stage === 'session refresh') {
      mocks.authenticate.mockResolvedValue({ authenticated: false });
      mocks.refresh.mockRejectedValue(transient);
    }
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 503);
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it('returns 503 if shared session recovery is unavailable', async () => {
    mocks.authenticate.mockResolvedValue({ authenticated: false });
    mocks.getRefreshedSession.mockRejectedValue(new Error('Session database unavailable'));
    const req = request(`sealed-recovery-${++sequence}`);
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 503);
  });

  it.each([
    ['JWKS HTTP response', Object.assign(new Error('Expected 200 OK from the JSON Web Key Set HTTP response'), {
      name: 'JOSEError', code: 'ERR_JOSE_GENERIC',
    })],
    ['malformed JWKS response', Object.assign(new Error('Failed to parse the JSON Web Key Set HTTP response as JSON'), {
      name: 'JOSEError', code: 'ERR_JOSE_GENERIC',
    })],
    ['provider HTTP 503', Object.assign(new Error('Service unavailable'), { status: 503 })],
    ['provider HTTP 429', Object.assign(new Error('Rate limited'), { statusCode: 429 })],
  ])('returns 503 for unavailable %s during JWT verification', async (_label, error) => {
    mocks.verifyWorkOSJWT.mockRejectedValue(error);
    const req = request(`header.unavailable${++sequence}.signature`, true);
    req.cookies['wos-session'] = 'otherwise-valid-cookie';
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 503);
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
  });

  it.each(['initial', 'shared'] as const)('returns 503 for a retryable %s refresh result and permits a later retry', async (stage) => {
    const token = `retryable-${stage}-${++sequence}`;
    mocks.authenticate.mockResolvedValue({ authenticated: false });
    if (stage === 'shared') {
      mocks.getRefreshedSession.mockResolvedValueOnce('shared-sealed-session');
      mocks.refresh.mockResolvedValueOnce({ authenticated: false, reason: 'invalid_grant', retryable: false });
    }
    mocks.refresh.mockResolvedValue({ authenticated: false, reason: 'server_error', retryable: true });
    const req = request(token);
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 503);

    mocks.authenticate.mockResolvedValue({ authenticated: true, user: { ...PROVIDER_USER }, accessToken: 'access-token' });
    const retry = request(token);
    const retryNext = vi.fn();
    await optionalAuth(retry, response(), retryNext);
    expect(retryNext).toHaveBeenCalledOnce();
    expect(retry.user?.authorizationSnapshot?.authenticatedUserId).toBe(AUTHENTICATED_ID);
  });

  it('returns 503 on a thrown provider HTTP 503 during session refresh', async () => {
    mocks.authenticate.mockResolvedValue({ authenticated: false });
    mocks.refresh.mockRejectedValue(Object.assign(new Error('Service unavailable'), { status: 503 }));
    const req = request(`refresh-503-${++sequence}`);
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 503);
  });

  it('returns 401 when sealed-session decoding rejects the presented credential', async () => {
    mocks.loadSealedSession.mockImplementationOnce(() => { throw new Error('Invalid sealed session'); });
    const req = request(`invalid-sealed-${++sequence}`);
    const res = response();
    const next = vi.fn();
    await optionalAuth(req, res, next);
    expectRejected(req, res, next, 401);
  });
});
afterAll(stopAuthTimers);

describe.each([
  ['required cookie', requireAuth, false], ['optional cookie', optionalAuth, false],
  ['required bearer', requireAuth, true], ['optional bearer', optionalAuth, true],
] as const)('%s authorization snapshots', (_label, middleware, bearer) => {
  function credential(): string {
    sequence += 1;
    return bearer ? `header.payload${sequence}.signature` : `sealed-snapshot-${sequence}`;
  }
  it('hydrates an atomic snapshot on cold start and every cached request', async () => {
    const token = credential();
    const first = request(token, bearer);
    const second = request(token, bearer);
    const next = vi.fn() as NextFunction;
    await middleware(first, response(), next);
    mocks.loadAuthorizationSnapshot.mockResolvedValue(snapshot({ authorizationEpoch: '2' }));
    await middleware(second, response(), next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenNthCalledWith(2, AUTHENTICATED_ID, null);
    expect(first.user?.authorizationSnapshot?.authorizationEpoch).toBe('1');
    expect(second.user?.authorizationSnapshot?.authorizationEpoch).toBe('2');
    expect(bearer ? mocks.verifyWorkOSJWT : mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
  it.each([
    ['secondary becomes primary', 'user_other_primary', AUTHENTICATED_ID],
    ['primary becomes secondary', AUTHENTICATED_ID, 'user_other_primary'],
  ])('keeps the exact credential when %s', async (_direction, before, after) => {
    const token = credential();
    mocks.loadAuthorizationSnapshot.mockResolvedValue(snapshot({ canonicalUserId: before }));
    const first = request(token, bearer);
    await middleware(first, response(), vi.fn());
    // A handler mutates its request object, which must never poison provider authentication.
    first.user!.id = 'user_attacker_canonical';
    first.user!.authWorkosUserId = 'user_attacker_credential';
    first.user!.identityId = 'identity_attacker';
    mocks.loadAuthorizationSnapshot.mockResolvedValue(snapshot({
      canonicalUserId: after, identityId: 'identity_changed', authorizationEpoch: '2',
    }));
    const second = request(token, bearer);
    const next = vi.fn();
    await middleware(second, response(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenLastCalledWith(AUTHENTICATED_ID, null);
    expect(second.user).toMatchObject({ id: after, identityId: 'identity_changed' });
    expect(second.user?.authWorkosUserId ?? second.user?.id).toBe(AUTHENTICATED_ID);
    expect(second.user?.authorizationSnapshot?.authorizationEpoch).toBe('2');
  });
  it.each(['cold', 'warm'] as const)('returns unavailable with no fallback on a %s-cache database outage', async (cacheState) => {
    const token = credential();
    if (cacheState === 'warm') await middleware(request(token, bearer), response(), vi.fn());
    mocks.loadAuthorizationSnapshot.mockRejectedValue(new AuthorizationSnapshotUnavailableError());
    const req = request(token, bearer);
    const res = response();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(bearer ? mocks.verifyWorkOSJWT : mocks.authenticate).toHaveBeenCalledTimes(1);
  });
  it('rejects a deleted exact credential instead of recovering its canonical user', async () => {
    const token = credential();
    await middleware(request(token, bearer), response(), vi.fn());
    mocks.loadAuthorizationSnapshot.mockResolvedValue(null);
    const req = request(token, bearer);
    const res = response();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
  it('keeps organization selection request-local across cache hits and leaves no selection empty', async () => {
    const token = credential();
    for (const org of ['org_pinnacle', 'org_streamhaus', null]) {
      const req = request(token, bearer);
      if (org) req.headers['x-organization-id'] = org;
      await middleware(req, response(), vi.fn());
      expect(mocks.loadAuthorizationSnapshot).toHaveBeenLastCalledWith(AUTHENTICATED_ID, org);
      expect(req.user?.authorizationSnapshot?.selectedOrganizationId).toBe(org);
    }
    expect(bearer ? mocks.verifyWorkOSJWT : mocks.authenticate).toHaveBeenCalledTimes(1);
  });
  it('uses current local credential email instead of a stale provider email', async () => {
    const token = credential();
    await middleware(request(token, bearer), response(), vi.fn());
    mocks.loadAuthorizationSnapshot.mockResolvedValue(snapshot({
      credential: { email: 'sam-current@example.test', firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true },
    }));
    const req = request(token, bearer);
    await middleware(req, response(), vi.fn());
    expect(req.user?.email).toBe('sam-current@example.test');
  });
  it('does not apply an old provider verification to the current unverified email', async () => {
    mocks.loadAuthorizationSnapshot.mockResolvedValue(snapshot({
      credential: { email: 'sam-unverified@example.test', firstName: 'Sam', lastName: 'Adeyemi', emailVerified: false },
    }));
    const req = request(credential(), bearer);
    await middleware(req, response(), vi.fn());
    expect(req.user).toMatchObject({ email: 'sam-unverified@example.test', emailVerified: false });
  });
  it('rejects conflicting explicit organization selectors before hydrating authority', async () => {
    const req = request(credential(), bearer);
    req.headers['x-organization-id'] = 'org_pinnacle';
    req.params.orgId = 'org_streamhaus';
    const res = response();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });
  it('keeps authorization provenance out of serialized and spread user objects', async () => {
    const req = request(credential(), bearer);
    await middleware(req, response(), vi.fn());
    expect(req.user?.authorizationSnapshot?.authenticatedUserId).toBe(AUTHENTICATED_ID);
    expect(JSON.stringify(req.user)).not.toContain('authorizationSnapshot');
    expect({ ...req.user }).not.toHaveProperty('authorizationSnapshot');
  });
});
it('a cookie cached by optional auth is rehydrated before required auth', async () => {
  const token = `shared-optional-${++sequence}`;
  await optionalAuth(request(token), response(), vi.fn());
  mocks.loadAuthorizationSnapshot.mockResolvedValue(snapshot({ canonicalUserId: 'user_changed', authorizationEpoch: '7' }));
  const second = request(token);
  await requireAuth(second, response(), vi.fn());
  expect(mocks.authenticate).toHaveBeenCalledTimes(1);
  expect(second.user).toMatchObject({ id: 'user_changed', authWorkosUserId: AUTHENTICATED_ID });
  expect(second.user?.authorizationSnapshot?.authorizationEpoch).toBe('7');
});

describe.each([['required', requireAuth], ['optional', optionalAuth]] as const)('%s bearer bans', (_label, middleware) => {
  it.each(['cold', 'warm'] as const)('checks the banned exact linked credential on a %s cache', async (cacheState) => {
    const token = `header.banned${++sequence}.signature`;
    mocks.loadAuthorizationSnapshot.mockResolvedValue(snapshot({ canonicalUserId: 'user_unbanned_primary' }));
    if (cacheState === 'warm') {
      await middleware(request(token, true), response(), vi.fn());
      invalidateBanCache('user', AUTHENTICATED_ID);
    }
    mocks.checkPlatformBan.mockImplementation(async (userId: string) => userId === AUTHENTICATED_ID
      ? { banned: true, ban: { id: 'ban_exact_credential', reason: 'Account suspended' } }
      : { banned: false });
    const res = response();
    const next = vi.fn();
    await middleware(request(token, true), res, next);
    expect(mocks.checkPlatformBan).toHaveBeenLastCalledWith(AUTHENTICATED_ID);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe.each([['required', requireAuth], ['optional', optionalAuth]] as const)('%s concurrent bearer hydration', (_label, middleware) => {
  it('keeps overlapping cached JWT requests bound to the original authenticated credential', async () => {
    const token = `header.overlapping${++sequence}.signature`;
    await middleware(request(token, true), response(), vi.fn());

    let resolveFirst!: (value: AuthorizationSnapshot) => void;
    let resolveSecond!: (value: AuthorizationSnapshot) => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const firstSnapshot = snapshot({ canonicalUserId: 'user_primary_a' });
    const secondSnapshot = snapshot({ canonicalUserId: 'user_primary_b', authorizationEpoch: '2' });
    mocks.loadAuthorizationSnapshot
      .mockImplementationOnce(() => {
        markFirstStarted();
        return new Promise<AuthorizationSnapshot>((resolve) => { resolveFirst = resolve; });
      })
      .mockImplementationOnce(() => {
        markSecondStarted();
        return new Promise<AuthorizationSnapshot>((resolve) => { resolveSecond = resolve; });
      })
      .mockResolvedValue(secondSnapshot);

    const first = request(token, true);
    const second = request(token, true);
    const firstNext = vi.fn();
    const secondNext = vi.fn();
    const firstPending = middleware(first, response(), firstNext);
    const secondPending = middleware(second, response(), secondNext);
    await Promise.all([firstStarted, secondStarted]);
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenNthCalledWith(2, AUTHENTICATED_ID, null);
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenNthCalledWith(3, AUTHENTICATED_ID, null);

    resolveFirst(firstSnapshot);
    await firstPending;
    const firstUser = first.user;
    expect(firstUser).toMatchObject({ id: 'user_primary_a', authWorkosUserId: AUTHENTICATED_ID });
    expect(firstUser?.authorizationSnapshot).toBe(firstSnapshot);
    expect(secondNext).not.toHaveBeenCalled();

    resolveSecond(secondSnapshot);
    await secondPending;
    expect(firstNext).toHaveBeenCalledOnce();
    expect(secondNext).toHaveBeenCalledOnce();
    expect(second.user).not.toBe(firstUser);
    expect(second.user).toMatchObject({ id: 'user_primary_b', authWorkosUserId: AUTHENTICATED_ID });
    expect(second.user?.authorizationSnapshot).toBe(secondSnapshot);
    expect(first.user).toBe(firstUser);
    expect(first.user).toMatchObject({ id: 'user_primary_a', authWorkosUserId: AUTHENTICATED_ID });
    expect(first.user?.authorizationSnapshot).toBe(firstSnapshot);

    const following = request(token, true);
    await middleware(following, response(), vi.fn());
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenNthCalledWith(4, AUTHENTICATED_ID, null);
    expect(following.user?.authorizationSnapshot?.authenticatedUserId).toBe(AUTHENTICATED_ID);
    expect(following.user?.authWorkosUserId).toBe(AUTHENTICATED_ID);
    expect(mocks.verifyWorkOSJWT).toHaveBeenCalledTimes(1);
  });
});

describe('optional authentication HTTP route boundary', () => {
  function route(parsedCookies: Record<string, string> = {}) {
    const app = express();
    // Match network-health-security.test.ts: authentication is under test, not
    // cookie-parser. Inject its parsed output from a fixture owned by this app;
    // the HTTP requests below send the corresponding Cookie header. An absent
    // cookie remains {}, while a presented empty cookie retains its empty value.
    app.use((req, _res, next) => {
      req.cookies = { ...parsedCookies };
      next();
    });
    app.use(csrfProtection);
    const handler = vi.fn((req: Request, res: Response) => {
      res.json({ authenticated: Boolean(req.user) });
    });
    app.get('/optional-auth-test', optionalAuth, handler);
    return { app, handler };
  }

  it('reaches the anonymous handler when neither Authorization nor Cookie is sent', async () => {
    const { app, handler } = route();
    const result = await supertest(app).get('/optional-auth-test');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ authenticated: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it.each(['', 'Basic invalid', 'Bearer header.invalid.signature'])('rejects supplied Authorization %j without using an otherwise valid cookie', async (authorization) => {
    mocks.verifyWorkOSJWT.mockRejectedValue(Object.assign(new Error('Invalid JWT signature'), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' }));
    const cookie = `otherwise-valid-${++sequence}`;
    const { app, handler } = route({ 'wos-session': cookie });
    const result = await supertest(app).get('/optional-auth-test')
      .set('Authorization', authorization)
      .set('Cookie', `wos-session=${cookie}`);
    expect(result.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it('rejects an opaque invalid bearer after validating that bearer rather than its companion cookie', async () => {
    mocks.authenticate.mockResolvedValue({ authenticated: false });
    const token = `invalid-native-route-${++sequence}`;
    const { app, handler } = route({ 'wos-session': 'otherwise-valid' });
    const result = await supertest(app).get('/optional-auth-test')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', 'wos-session=otherwise-valid');
    expect(result.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.loadSealedSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionData: token }));
  });

  it.each(['empty', 'invalid'] as const)('rejects an %s presented wos-session cookie before the handler', async (kind) => {
    mocks.authenticate.mockResolvedValue({ authenticated: false });
    const token = kind === 'empty' ? '' : `invalid-cookie-route-${++sequence}`;
    const { app, handler } = route({ 'wos-session': token });
    const result = await supertest(app).get('/optional-auth-test').set('Cookie', `wos-session=${token}`);
    expect(result.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
    if (kind === 'empty') expect(mocks.loadSealedSession).not.toHaveBeenCalled();
  });

  it.each(['bearer', 'cookie'] as const)('returns 503 for unavailable authorization on a presented %s without running the handler', async (kind) => {
    mocks.loadAuthorizationSnapshot.mockRejectedValue(new AuthorizationSnapshotUnavailableError());
    const cookie = `unavailable-route-${++sequence}`;
    const { app, handler } = route(kind === 'cookie' ? { 'wos-session': cookie } : {});
    const httpRequest = supertest(app).get('/optional-auth-test');
    if (kind === 'bearer') httpRequest.set('Authorization', `Bearer header.route${++sequence}.signature`);
    else httpRequest.set('Cookie', `wos-session=${cookie}`);
    const result = await httpRequest;
    expect(result.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenCalledOnce();
  });
});
