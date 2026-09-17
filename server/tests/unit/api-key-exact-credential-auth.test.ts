import type { Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  checkPlatformBan: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
  loadSealedSession: vi.fn(),
  verifyWorkOSJWT: vi.fn(),
  loadAuthorizationSnapshot: vi.fn(),
  getRefreshedSession: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_server_test';
  process.env.WORKOS_CLIENT_ID = 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-characters';
  process.env.ADMIN_API_KEY = 'static-admin-test';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    apiKeys = { createValidation: mocks.createValidation };
    userManagement = { loadSealedSession: mocks.loadSealedSession };
  },
}));
vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBanForApiKey: mocks.checkPlatformBanForApiKey,
    checkPlatformBan: mocks.checkPlatformBan,
  },
}));
vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));
vi.mock('../../src/auth/workos-jwt.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/auth/workos-jwt.js')>(),
  verifyWorkOSJWT: mocks.verifyWorkOSJWT,
}));
vi.mock('../../src/db/user-authorization-snapshot-db.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/user-authorization-snapshot-db.js')>(),
  loadAuthorizationSnapshot: mocks.loadAuthorizationSnapshot,
}));
vi.mock('../../src/db/session-refresh-db.js', () => ({
  getRefreshedSession: mocks.getRefreshedSession,
  storeRefreshedSession: vi.fn().mockResolvedValue(undefined),
  cleanExpiredRefreshes: vi.fn().mockResolvedValue(0),
}));

import {
  optionalAuth,
  requireAuth,
  requireAdmin,
  requireTenantAdminForOrganization,
  stopAuthTimers,
  type ValidatedApiKey,
} from '../../src/middleware/auth.js';

type KeyRequest = Request & { apiKey?: ValidatedApiKey };

function makeRequest(token = 'sk_tenant_key', orgId?: string): KeyRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: { 'wos-session': 'valid-broader-session' },
    params: orgId ? { orgId } : {},
    path: '/api/admin/organizations',
    originalUrl: '/api/admin/organizations',
    method: 'GET',
    accepts: () => false,
  } as unknown as KeyRequest;
}

function makeResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function tenantKey(id = 'key_a', organizationId = 'org_a', permissions = ['admin:*']) {
  return {
    apiKey: {
      id,
      owner: { type: 'organization', id: organizationId },
      name: 'Tenant key',
      permissions,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createValidation.mockResolvedValue(tenantKey());
  mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false });
  mocks.checkPlatformBan.mockResolvedValue({ banned: false });
  mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: false });
  mocks.getRefreshedSession.mockResolvedValue(null);
  mocks.loadAuthorizationSnapshot.mockImplementation(async (id: string, org: string | null) => ({
    authenticatedUserId: id, canonicalUserId: id, identityId: 'identity_one',
    authorizationEpoch: '1', selectedOrganizationId: org, credentialGrant: null,
    credential: { email: 'sam@example.test', emailVerified: true, firstName: 'Sam', lastName: 'Adeyemi' },
  }));
});
afterAll(stopAuthTimers);

describe.each([
  ['requireAuth', requireAuth],
  ['optionalAuth', optionalAuth],
] as const)('%s exact API-key credential', (_name, authenticate) => {
  it.each(['bearer sk_revoked', 'BEARER sk_revoked', 'Bearer   sk_revoked', 'Bearer\tsk_revoked', 'bEaReR  wos_api_key_revoked'])(
    'recognizes the selected API key with alternate header formatting: %s', async (authorization) => {
      mocks.createValidation.mockResolvedValue({ apiKey: null });
      const req = makeRequest();
      req.headers.authorization = authorization;
      const res = makeResponse();
      const next = vi.fn();

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mocks.createValidation).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
      expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid or revoked key without using an accompanying session', async () => {
    mocks.createValidation.mockResolvedValue({ apiKey: null });
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_api_key' });
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(req.apiKey).toBeUndefined();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.verifyWorkOSJWT).not.toHaveBeenCalled();
  });

  it.each([undefined, 401, 403, 429, 503])('fails unavailable validation closed for provider status %s', async (status) => {
    mocks.createValidation.mockRejectedValue(Object.assign(new Error('provider error'), { status }));
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'authorization_unavailable' });
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
  });

  it('rejects a user-owned key without inferring organization authority', async () => {
    const owner = { type: 'user', id: 'user_linked', organizationId: 'org_a' };
    mocks.createValidation.mockResolvedValue({ apiKey: { ...tenantKey().apiKey, owner } });
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.resolveEffectiveMembership).not.toHaveBeenCalled();
  });

  it.each([
    ['header', (req: KeyRequest) => { req.headers['x-organization-id'] = 'org_b'; }],
    ['query org', (req: KeyRequest) => { req.query = { org: 'org_b' }; }],
    ['query organization_id', (req: KeyRequest) => { req.query = { organization_id: 'org_b' }; }],
    ['query organizationId', (req: KeyRequest) => { req.query = { organizationId: 'org_b' }; }],
    ['body organization_id', (req: KeyRequest) => { req.body = { organization_id: 'org_b' }; }],
    ['body organizationId', (req: KeyRequest) => { req.body = { organizationId: 'org_b' }; }],
    ['route orgId', (req: KeyRequest) => { req.params = { orgId: 'org_b' }; }],
    ['route organizationId', (req: KeyRequest) => { req.params = { organizationId: 'org_b' }; }],
  ] as const)('rejects an API key provider conflict from %s before attaching authority', async (_location, select) => {
    const req = makeRequest();
    select(req);
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(req.apiKey).toBeUndefined();
    expect(mocks.checkPlatformBanForApiKey).not.toHaveBeenCalled();
  });

  it.each([
    { owner: { id: 'org_a' } },
    { owner: null },
    { owner: { type: 'organization', id: '' } },
    { id: '' },
    { permissions: undefined },
    { permissions: ['admin:*', null] },
  ])('refuses incomplete provider authorization data: %j', async (invalidFields) => {
    mocks.createValidation.mockResolvedValue({ apiKey: { ...tenantKey().apiKey, ...invalidFields } });
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    expect(req.apiKey).toBeUndefined();
  });

  it('does not attach a principal when the key ban check is unavailable', async () => {
    mocks.checkPlatformBanForApiKey.mockRejectedValue(new Error('database unavailable'));
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(req.apiKey).toBeUndefined();
  });

  it('does not cache an accepted key across revocation or rotation', async () => {
    mocks.createValidation
      .mockResolvedValueOnce(tenantKey('old_key'))
      .mockResolvedValueOnce({ apiKey: null })
      .mockResolvedValueOnce(tenantKey('new_key'))
      .mockResolvedValueOnce({ apiKey: null });
    const requests = [makeRequest('sk_old'), makeRequest('sk_old'), makeRequest('sk_new'), makeRequest('sk_old')];
    const responses = requests.map(() => makeResponse());
    const next = vi.fn();

    for (const [index, req] of requests.entries()) {
      await authenticate(req, responses[index], next);
    }

    expect(mocks.createValidation.mock.calls.map(([args]) => args.value)).toEqual(['sk_old', 'sk_old', 'sk_new', 'sk_old']);
    expect(next).toHaveBeenCalledTimes(2);
    expect(requests[0].apiKey?.id).toBe('old_key');
    expect(requests[2].apiKey?.id).toBe('new_key');
    expect(responses[1].status).toHaveBeenCalledWith(401);
    expect(responses[3].status).toHaveBeenCalledWith(401);
  });

  it('does not reuse a stale ban allow decision', async () => {
    mocks.checkPlatformBanForApiKey
      .mockResolvedValueOnce({ banned: false })
      .mockResolvedValueOnce({ banned: true });
    const next = vi.fn();
    const deniedRequest = makeRequest();
    const deniedResponse = makeResponse();

    await authenticate(makeRequest(), makeResponse(), next);
    await authenticate(deniedRequest, deniedResponse, next);

    expect(mocks.checkPlatformBanForApiKey).toHaveBeenCalledTimes(2);
    expect(deniedResponse.status).toHaveBeenCalledWith(403);
    expect(deniedRequest.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps concurrent validation decisions and tenant principals separate', async () => {
    let releaseFirst!: (result: ReturnType<typeof tenantKey>) => void;
    mocks.createValidation.mockImplementation(({ value }: { value: string }) => value === 'sk_a'
      ? new Promise<ReturnType<typeof tenantKey>>((resolve) => { releaseFirst = resolve; })
      : Promise.resolve(tenantKey('key_b', 'org_b', ['admin:read'])));
    const requestA = makeRequest('sk_a');
    const requestB = makeRequest('sk_b');
    const nextA = vi.fn();
    const nextB = vi.fn();

    const pendingA = authenticate(requestA, makeResponse(), nextA);
    await authenticate(requestB, makeResponse(), nextB);
    expect(nextA).not.toHaveBeenCalled();
    releaseFirst(tenantKey('key_a', 'org_a'));
    await pendingA;

    expect(requestA.apiKey).toMatchObject({ id: 'key_a', organizationId: 'org_a', permissions: ['admin:*'] });
    expect(requestB.apiKey).toMatchObject({ id: 'key_b', organizationId: 'org_b', permissions: ['admin:read'] });
    expect(requestA.user).not.toBe(requestB.user);
    expect(nextA).toHaveBeenCalledOnce();
    expect(nextB).toHaveBeenCalledOnce();
  });
});

describe('tenant-key use scope', () => {
  it.each([
    ['org_a', 'GET', ['admin:*'], true],
    ['org_a', 'GET', ['admin:read'], true],
    ['org_b', 'GET', ['admin:*'], false],
    [undefined, 'GET', ['admin:*'], false],
    ['org_a', 'DELETE', ['admin:read'], false],
    ['org_a', 'GET', ['admin'], false],
    ['org_a', 'GET', [], false],
  ] as const)('requires exact selected org and permission: %s %s %j', async (orgId, method, permissions, allowed) => {
    mocks.createValidation.mockResolvedValue(tenantKey('key_a', 'org_a', [...permissions]));
    const req = makeRequest('sk_a', orgId);
    req.method = method;
    const res = makeResponse();
    const authenticated = vi.fn();
    const authorized = vi.fn();

    await requireAuth(req, res, authenticated);
    await requireTenantAdminForOrganization(req, res, authorized);

    if (orgId === 'org_b') {
      expect(authenticated).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
      expect(req.apiKey).toBeUndefined();
    } else {
      expect(authenticated).toHaveBeenCalledOnce();
    }
    if (allowed) expect(authorized).toHaveBeenCalledOnce();
    else {
      expect(authorized).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it('uses current permissions when the same key is revalidated', async () => {
    mocks.createValidation
      .mockResolvedValueOnce(tenantKey('key_a', 'org_a', ['admin:*']))
      .mockResolvedValueOnce(tenantKey('key_a', 'org_a', ['admin:read']));
    const authorized = vi.fn();
    for (let i = 0; i < 2; i++) {
      const req = makeRequest('sk_a', 'org_a');
      req.method = 'DELETE';
      await requireAuth(req, makeResponse(), vi.fn());
      await requireTenantAdminForOrganization(req, makeResponse(), authorized);
    }
    expect(authorized).toHaveBeenCalledOnce();
  });

  it.each(['admin:*', 'admin:read'])('never upgrades a tenant %s key to platform administration', async (permission) => {
    mocks.createValidation.mockResolvedValue(tenantKey('key_a', 'org_a', [permission]));
    const req = makeRequest('sk_a', 'org_a');
    const res = makeResponse();
    const next = vi.fn();

    await requireAuth(req, res, vi.fn());
    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'global_admin_required' }));
    expect(next).not.toHaveBeenCalled();
  });
});

let bearerSequence = 0;

describe.each([
  ['requireAuth', requireAuth], ['optionalAuth', optionalAuth],
] as const)('%s explicit bearer selection', (_name, authenticate) => {
  function noCookieRequest(authorization: string): KeyRequest {
    const req = makeRequest();
    req.headers.authorization = authorization;
    Object.defineProperty(req, 'cookies', {
      get: () => { throw new Error('An explicit bearer must never read a cookie'); },
    });
    return req;
  }

  it.each(['Bearer', 'Bearer ', 'bearer   ', 'BEARER\t', 'Bearer eyJmalformed', 'bEaReR eyJmalformed..'])(
    'rejects empty or malformed JWT bearer %j without reading the cookie', async (authorization) => {
      const req = noCookieRequest(authorization);
      const res = makeResponse();
      const next = vi.fn();

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
      expect(mocks.loadSealedSession).not.toHaveBeenCalled();
      expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each([
    'ERR_JWT_EXPIRED', 'ERR_JWT_INVALID', 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWS_INVALID', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JWKS_NO_MATCHING_KEY',
    'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED',
  ])('returns 401 for definitive JWT rejection %s without cookie fallback', async (code) => {
    mocks.verifyWorkOSJWT.mockRejectedValue(Object.assign(new Error('Invalid token'), { code }));
    const req = noCookieRequest(`bearer eyJ.reject${++bearerSequence}.signature`);
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Unknown provider failure'),
    Object.assign(new Error('Unknown JWKS failure'), { code: 'ERR_JOSE_GENERIC' }),
    Object.assign(new Error('Invalid key service response'), { code: 'ERR_JWKS_INVALID' }),
    Object.assign(new Error('Timeout'), { code: 'ERR_JWKS_TIMEOUT' }),
    Object.assign(new Error('Fetch failed'), { code: 'ECONNRESET' }),
    Object.assign(new Error('Provider authorization unavailable'), { status: 401 }),
    Object.assign(new Error('Provider unavailable'), { status: 503 }),
  ])('returns 503 for unavailable JWT verification: %s', async (error) => {
    mocks.verifyWorkOSJWT.mockRejectedValue(error);
    const req = noCookieRequest(`BEARER   eyJ.unavailable${++bearerSequence}.signature`);
    const res = makeResponse();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it.each(['wrong-static-token', 'malformed-opaque-token'])(
    'validates only the selected opaque bearer %s, never an accompanying valid cookie', async (token) => {
      const req = makeRequest(`${token}-${++bearerSequence}`);
      const res = makeResponse();
      const next = vi.fn();
      mocks.loadSealedSession.mockImplementation(({ sessionData }: { sessionData: string }) => ({
        authenticate: vi.fn().mockResolvedValue(sessionData === 'valid-broader-session' ? {
          authenticated: true,
          user: { id: 'broader_cookie_user', email: 'cookie@example.test' },
          accessToken: 'cookie-access',
        } : { authenticated: false }),
        refresh: vi.fn().mockResolvedValue({ authenticated: false }),
      }));

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
      expect(mocks.loadSealedSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionData: `${token}-${bearerSequence}` }));
      expect(mocks.loadAuthorizationSnapshot).not.toHaveBeenCalled();
    },
  );

  it('continues to authenticate a valid JWT with its exact snapshot and selected org', async () => {
    mocks.verifyWorkOSJWT.mockResolvedValue({ sub: 'user_authenticated', orgId: 'org_selected', isM2M: false });
    const req = noCookieRequest(`bEaReR\teyJ.valid${++bearerSequence}.signature`);
    const next = vi.fn();

    await authenticate(req, makeResponse(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.authorizationSnapshot?.authenticatedUserId).toBe('user_authenticated');
    expect(mocks.loadAuthorizationSnapshot).toHaveBeenCalledExactlyOnceWith('user_authenticated', 'org_selected');
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
  });

  it('continues to authenticate native sealed bearer sessions without reading a cookie', async () => {
    const token = `native-sealed-${++bearerSequence}`;
    const req = noCookieRequest(`BEARER ${token}`);
    const next = vi.fn();
    mocks.loadSealedSession.mockReturnValue({ authenticate: vi.fn().mockResolvedValue({
      authenticated: true, user: { id: 'user_native', email: 'native@example.test' }, accessToken: 'native-access',
    }) });

    await authenticate(req, makeResponse(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.authorizationSnapshot?.authenticatedUserId).toBe('user_native');
    expect(mocks.loadSealedSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionData: token }));
  });

  it('continues to authenticate the configured static bearer credential', async () => {
    const req = noCookieRequest('bearer  static-admin-test');
    const next = vi.fn();

    await authenticate(req, makeResponse(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.id).toBe('admin_api_key');
    expect(mocks.loadSealedSession).not.toHaveBeenCalled();
    expect(mocks.verifyWorkOSJWT).not.toHaveBeenCalled();
  });
});

describe.each([
  ['requireAuth', requireAuth], ['optionalAuth', optionalAuth],
] as const)('%s sealed bearer unavailable state', (_label, authenticate) => {
  it.each(['initial', 'shared'] as const)('does not mark a retryable %s refresh as a dead credential', async (stage) => {
    const token = `retryable-sealed-${++bearerSequence}`;
    const authenticateSession = vi.fn().mockResolvedValue({ authenticated: false });
    const refresh = vi.fn().mockResolvedValue({ authenticated: false, retryable: true });
    if (stage === 'shared') {
      refresh.mockResolvedValueOnce({ authenticated: false, retryable: false });
      mocks.getRefreshedSession.mockResolvedValueOnce('shared-sealed');
    }
    mocks.loadSealedSession.mockReturnValue({ authenticate: authenticateSession, refresh });
    const unavailableResponse = makeResponse();
    const next = vi.fn();
    await authenticate(makeRequest(token), unavailableResponse, next);
    expect(unavailableResponse.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();

    authenticateSession.mockResolvedValue({
      authenticated: true, user: { id: 'user_recovered', email: 'sam@example.test' }, accessToken: 'recovered',
    });
    const recoveredResponse = makeResponse();
    await authenticate(makeRequest(token), recoveredResponse, next);
    expect(next).toHaveBeenCalledOnce();
    expect(recoveredResponse.status).not.toHaveBeenCalled();
  });

  it.each(['authenticate', 'refresh', 'shared refresh'] as const)(
    'keeps unknown provider/JWKS failures in %s unavailable and retryable', async (stage) => {
      const token = `unavailable-sealed-${++bearerSequence}`;
      const authenticateSession = vi.fn().mockResolvedValue({ authenticated: false });
      const refresh = vi.fn().mockRejectedValue(new Error('Unknown provider or key-service failure'));
      if (stage === 'authenticate') authenticateSession.mockRejectedValueOnce(new Error('Unknown JWKS failure'));
      if (stage === 'shared refresh') {
        refresh.mockResolvedValueOnce({ authenticated: false, retryable: false });
        mocks.getRefreshedSession.mockResolvedValueOnce('shared-sealed');
      }
      mocks.loadSealedSession.mockReturnValue({ authenticate: authenticateSession, refresh });
      const res = makeResponse();
      const next = vi.fn();
      await authenticate(makeRequest(token), res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
      authenticateSession.mockResolvedValue({
        authenticated: true, user: { id: 'user_recovered', email: 'sam@example.test' }, accessToken: 'recovered',
      });
      await authenticate(makeRequest(token), makeResponse(), next);
      expect(next).toHaveBeenCalledOnce();
    },
  );
});
