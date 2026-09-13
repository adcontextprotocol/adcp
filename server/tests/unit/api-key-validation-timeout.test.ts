import type { Request, Response } from 'express';
import { WorkOS } from '@workos-inc/node';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const snapshotMock = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_server_test';
  process.env.WORKOS_CLIENT_ID = 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-characters';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
  vi.stubGlobal('fetch', fetchMock);
});
vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBanForApiKey: vi.fn().mockResolvedValue({ banned: false }),
    checkPlatformBan: vi.fn().mockResolvedValue({ banned: false }),
  },
}));
vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: vi.fn().mockResolvedValue({ is_member: false }),
}));
vi.mock('../../src/db/user-authorization-snapshot-db.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/user-authorization-snapshot-db.js')>(),
  loadAuthorizationSnapshot: snapshotMock,
}));
import { optionalAuth, requireAuth, stopAuthTimers } from '../../src/middleware/auth.js';

function request(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: { 'wos-session': 'valid-broader-cookie' },
    path: '/api/test', originalUrl: '/api/test', accepts: () => false,
  } as unknown as Request;
}
function response(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}
beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); snapshotMock.mockReset(); });
afterEach(() => vi.useRealTimers());
afterAll(() => { stopAuthTimers(); vi.unstubAllGlobals(); });

describe('actual WorkOS client API-key request budget', () => {
  it('aborts at five seconds without SDK retries and permits a fresh request', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const res = response();
    const next = vi.fn();
    const pending = requireAuth(request('sk_retry'), res, next);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.workos.com/api_keys/validations');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new globalThis.Response(JSON.stringify({ api_key: {
      id: 'key_retry', owner: { type: 'organization', id: 'org_selected' }, name: 'Retried key', permissions: [],
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await requireAuth(request('sk_retry'), response(), next);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([requireAuth, optionalAuth])('rejects actual SDK malformed sealed bearer errors as 401 (%s)', async (authenticate) => {
    for (const token of [
      'Fe26.2*1*salt*iv*encrypted*nope*hmacsalt*hmac~2',
      'Fe26.2*1*salt*iv*encrypted**hmacsalt*!~2',
    ]) {
      const res = response();
      const next = vi.fn();
      await authenticate(request(token), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 503 for an unsupported provider JWK inside a sealed Bearer despite a valid cookie', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const accessTokens = new Map<string, string>();
    for (const credential of ['cookie', 'bearer']) {
      accessTokens.set(credential, await new SignJWT({ sub: `user_${credential}`, org_id: `org_${credential}` })
        .setProtectedHeader({ alg: 'RS256', kid: credential }).setExpirationTime('1h').sign(privateKey));
    }
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.workos.com/sso/jwks/client_test') {
        return new globalThis.Response(JSON.stringify({ keys: [
          { ...jwk, kid: 'cookie' }, { ...jwk, kid: 'bearer', oth: [] },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://api.workos.com/user_management/authenticate') {
        const { code } = JSON.parse(init!.body as string);
        return new globalThis.Response(JSON.stringify({
          access_token: accessTokens.get(code), refresh_token: `refresh_${code}`,
          user: { id: `user_${code}`, email: `${code}@example.test`, email_verified: true },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected WorkOS request: ${url}`);
    });
    const sdk = new WorkOS(process.env.WORKOS_API_KEY!, { clientId: process.env.WORKOS_CLIENT_ID });
    const seal = async (code: string) => (await sdk.userManagement.authenticateWithCode({
      code, session: { sealSession: true, cookiePassword: process.env.WORKOS_COOKIE_PASSWORD! },
    })).sealedSession!;
    const cookie = await seal('cookie');
    const bearer = await seal('bearer');
    await expect(sdk.userManagement.loadSealedSession({
      sessionData: bearer, cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
    }).authenticate()).rejects.toMatchObject({ code: 'ERR_JOSE_NOT_SUPPORTED' });
    snapshotMock.mockImplementation(async (id: string, org: string | null) => ({
      authenticatedUserId: id, canonicalUserId: id, identityId: null, authorizationEpoch: '1',
      selectedOrganizationId: org, credentialGrant: null,
      credential: { email: `${id}@example.test`, emailVerified: true, firstName: null, lastName: null },
    }));

    // Prove the accompanying cookie really authenticates through the installed SDK.
    const cookieRequest = request(bearer);
    cookieRequest.headers = {};
    cookieRequest.cookies['wos-session'] = cookie;
    const cookieNext = vi.fn();
    await requireAuth(cookieRequest, response(), cookieNext);
    expect(cookieNext).toHaveBeenCalledOnce();
    expect(cookieRequest.user?.id).toBe('user_cookie');
    snapshotMock.mockClear();

    for (const authenticate of [requireAuth, optionalAuth]) {
      const req = request(bearer);
      req.cookies['wos-session'] = cookie;
      const res = response();
      const next = vi.fn();
      await authenticate(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    }
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === 'https://api.workos.com/user_management/authenticate'))
      .toHaveLength(2); // Creating the fixtures only; no credential refresh/fallback.
  });
});
