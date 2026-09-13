/**
 * Persisted authorization epoch enforcement (#6827).
 *
 * The session cache is per-instance, so evicting it cannot revoke authority
 * granted before an identity-binding change — another instance still serves
 * its own cached entry. These tests pin the replacement: every cache hit
 * revalidates the persisted epoch fingerprint stamped when the entry was
 * stored, and a moved fingerprint forces full re-validation.
 */

import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  loadSealedSession: vi.fn(),
  checkPlatformBan: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  readCredentialAuthorizationLifecycle: vi.fn(),
  poolQuery: vi.fn(),
  verifyWorkOSJWT: vi.fn(),
}));

vi.hoisted(() => {
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD =
    process.env.WORKOS_COOKIE_PASSWORD ?? 'placeholder-cookie-password-32-bytes-min';
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return {
      userManagement: {
        loadSealedSession: mocks.loadSealedSession,
      },
      apiKeys: { createValidation: vi.fn() },
    };
  }),
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBan: mocks.checkPlatformBan,
    checkPlatformBanForApiKey: mocks.checkPlatformBanForApiKey,
  },
}));

vi.mock('../../src/db/authorization-epoch-db.js', () => ({
  readCredentialAuthorizationLifecycle: mocks.readCredentialAuthorizationLifecycle,
  bumpAuthorizationEpochs: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
  query: mocks.poolQuery,
  isDatabaseInitialized: () => true,
}));

vi.mock('../../src/auth/workos-jwt.js', () => ({
  looksLikeJWT: vi.fn(() => true),
  verifyWorkOSJWT: mocks.verifyWorkOSJWT,
}));

import { optionalAuth, requireAuth, validateWorkOSBearerJWT } from '../../src/middleware/auth.js';

const SESSION_USER = {
  id: 'user_epoch_primary',
  email: 'primary@epoch.test',
  firstName: 'Epoch',
  lastName: 'User',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeRequest(cookie: string): Request {
  return {
    headers: {},
    cookies: { 'wos-session': cookie },
    path: '/api/me',
    originalUrl: '/api/me',
    accepts: () => false,
  } as unknown as Request;
}

function makeResponse(): Response {
  return {
    cookie: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function makeBearerRequest(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as Request;
}

function activeLifecycle(fingerprint: string) {
  return {
    status: 'active' as const,
    snapshot: {
      workos_user_id: SESSION_USER.id,
      email: SESSION_USER.email,
      first_name: SESSION_USER.firstName,
      last_name: SESSION_USER.lastName,
      identity_id: 'identity_epoch',
      primary_workos_user_id: SESSION_USER.id,
      fingerprint,
    },
  };
}

describe('persisted authorization epoch gates the session cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkPlatformBan.mockResolvedValue({ banned: false, ban: null });
    // Local user lookup resolves; attachIdentityId sees a singleton identity
    // (primary === authenticated credential), so there is no id-swap.
    mocks.poolQuery.mockResolvedValue({
      rows: [
        {
          first_name: 'Epoch',
          last_name: 'User',
          identity_id: 'identity_epoch',
          primary_workos_user_id: 'user_epoch_primary',
        },
      ],
      rowCount: 1,
    });
    mocks.authenticate.mockResolvedValue({
      authenticated: true,
      user: SESSION_USER,
      accessToken: 'access-token',
    });
    mocks.loadSealedSession.mockReturnValue({
      authenticate: mocks.authenticate,
      refresh: vi.fn(),
    });
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue(
      activeLifecycle('user_epoch_primary:1'),
    );
    mocks.verifyWorkOSJWT.mockResolvedValue({
      sub: SESSION_USER.id,
      email: SESSION_USER.email,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      isM2M: false,
    });
  });

  it('serves the cached session while the fingerprint is unchanged', async () => {
    const cookie = `sealed-unchanged-${Date.now()}`;
    const next = vi.fn() as NextFunction;

    await requireAuth(makeRequest(cookie), makeResponse(), next);
    await requireAuth(makeRequest(cookie), makeResponse(), next);

    expect(next).toHaveBeenCalledTimes(2);
    // Second request came from cache — the sealed session was unsealed once.
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
  });

  it('re-validates when an identity-binding change moved the fingerprint', async () => {
    const cookie = `sealed-bumped-${Date.now()}`;
    const next = vi.fn() as NextFunction;

    await requireAuth(makeRequest(cookie), makeResponse(), next);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);

    // A binding mutation bumped the credential's epoch on another instance.
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue(
      activeLifecycle('user_epoch_primary:2'),
    );

    await requireAuth(makeRequest(cookie), makeResponse(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when the epoch lookup fails rather than serving unconfirmed state', async () => {
    const cookie = `sealed-lookup-error-${Date.now()}`;
    const next = vi.fn() as NextFunction;

    await requireAuth(makeRequest(cookie), makeResponse(), next);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);

    mocks.readCredentialAuthorizationLifecycle.mockResolvedValueOnce({ status: 'unavailable' });

    await requireAuth(makeRequest(cookie), makeResponse(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
  });

  it('denies an epoch-0 credential on replica B immediately after replica A records deletion', async () => {
    const cookie = `sealed-epoch-zero-deleted-${Date.now()}`;
    const next = vi.fn() as NextFunction;
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue(activeLifecycle(''));

    await requireAuth(makeRequest(cookie), makeResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);

    // Replica A committed a non-cascading deletion tombstone. Replica B still
    // has its own cold epoch-0 session entry, but the next hit sees the marker.
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue({
      status: 'terminal', reason: 'deleted_or_quarantined',
    });
    const response = makeResponse();
    await requireAuth(makeRequest(cookie), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('does not serve replica-B cached authority when deletion-marker lookup is unavailable', async () => {
    const cookie = `sealed-deletion-marker-outage-${Date.now()}`;
    const next = vi.fn() as NextFunction;
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue(activeLifecycle(''));

    await requireAuth(makeRequest(cookie), makeResponse(), next);
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue({ status: 'unavailable' });
    const response = makeResponse();
    await requireAuth(makeRequest(cookie), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('invalidates replica B through persistence when only replica A receives local eviction', async () => {
    vi.resetModules();
    const replicaA = await import('../../src/middleware/auth.js');
    vi.resetModules();
    const replicaB = await import('../../src/middleware/auth.js');
    const cookieA = `sealed-replica-a-${Date.now()}`;
    const cookieB = `sealed-replica-b-${Date.now()}`;
    const nextA = vi.fn() as NextFunction;
    const nextB = vi.fn() as NextFunction;
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue(activeLifecycle(''));

    await replicaA.requireAuth(makeRequest(cookieA), makeResponse(), nextA);
    await replicaB.requireAuth(makeRequest(cookieB), makeResponse(), nextB);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);

    // The deletion process only has access to replica A's in-memory cache.
    // Replica B retains its independent entry and must observe the durable
    // deletion marker on its immediate next request, without waiting for TTL.
    replicaA.invalidateSessionsForUsers([SESSION_USER.id]);
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue({
      status: 'terminal', reason: 'deleted_or_quarantined',
    });
    const responseB = makeResponse();
    await replicaB.requireAuth(makeRequest(cookieB), responseB, nextB);

    expect(nextB).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledTimes(3);
    expect(responseB.status).toHaveBeenCalledWith(401);
  });

  it('denies an epoch-0 cached bearer JWT on the immediate hit after deletion', async () => {
    const token = `header.${Date.now()}.signature`;
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue(activeLifecycle(''));

    await expect(validateWorkOSBearerJWT(makeBearerRequest(token))).resolves.toMatchObject({
      user: { id: SESSION_USER.id },
    });
    expect(mocks.verifyWorkOSJWT).toHaveBeenCalledTimes(1);

    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue({
      status: 'terminal', reason: 'deleted_or_quarantined',
    });
    await expect(validateWorkOSBearerJWT(makeBearerRequest(token))).resolves.toBeNull();

    expect(mocks.verifyWorkOSJWT).toHaveBeenCalledTimes(2);
  });

  it('cannot poison requireAuth from optionalAuth with a deleted sealed credential', async () => {
    const cookie = `sealed-optional-poison-${Date.now()}`;
    const optionalRequest = makeRequest(cookie);
    const optionalNext = vi.fn() as NextFunction;
    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue({
      status: 'terminal', reason: 'deleted_or_quarantined',
    });

    await optionalAuth(optionalRequest, makeResponse(), optionalNext);
    expect(optionalNext).toHaveBeenCalledTimes(1);
    expect(optionalRequest.user).toBeUndefined();

    const requiredResponse = makeResponse();
    const requiredNext = vi.fn() as NextFunction;
    await requireAuth(makeRequest(cookie), requiredResponse, requiredNext);

    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(requiredNext).not.toHaveBeenCalled();
    expect(requiredResponse.status).toHaveBeenCalledWith(401);
  });

  it('cannot serve optionalAuth from a requireAuth cache after deletion', async () => {
    const cookie = `sealed-required-poison-${Date.now()}`;
    const requiredNext = vi.fn() as NextFunction;
    await requireAuth(makeRequest(cookie), makeResponse(), requiredNext);
    expect(requiredNext).toHaveBeenCalledTimes(1);

    mocks.readCredentialAuthorizationLifecycle.mockResolvedValue({
      status: 'terminal', reason: 'deleted_or_quarantined',
    });
    const optionalRequest = makeRequest(cookie);
    const optionalNext = vi.fn() as NextFunction;
    await optionalAuth(optionalRequest, makeResponse(), optionalNext);

    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(optionalNext).toHaveBeenCalledTimes(1);
    expect(optionalRequest.user).toBeUndefined();
  });
});
