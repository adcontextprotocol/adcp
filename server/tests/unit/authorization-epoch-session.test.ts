/** Provider caches must never become identity, organization, or epoch authority. */
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), loadSealedSession: vi.fn(), checkPlatformBan: vi.fn(),
  loadAuthorizationSnapshot: vi.fn(), verifyWorkOSJWT: vi.fn(), poolQuery: vi.fn(),
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
vi.mock('../../src/auth/workos-jwt.js', () => ({
  verifyWorkOSJWT: mocks.verifyWorkOSJWT,
  looksLikeJWT: (token: string) => token.split('.').length === 3,
}));
vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }), query: mocks.poolQuery, isDatabaseInitialized: () => true,
}));
import { AuthorizationSnapshotUnavailableError } from '../../src/db/user-authorization-snapshot-db.js';
import { invalidateBanCache, optionalAuth, requireAuth, stopAuthTimers } from '../../src/middleware/auth.js';

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
  mocks.loadSealedSession.mockReturnValue({ authenticate: mocks.authenticate, refresh: vi.fn() });
  mocks.verifyWorkOSJWT.mockResolvedValue({ sub: AUTHENTICATED_ID, email: PROVIDER_USER.email, isM2M: false });
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
