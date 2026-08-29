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
  getAuthorizationFingerprint: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.hoisted(() => {
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
  getAuthorizationFingerprint: mocks.getAuthorizationFingerprint,
  bumpAuthorizationEpochs: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
  query: mocks.poolQuery,
  isDatabaseInitialized: () => true,
}));

import { requireAuth } from '../../src/middleware/auth.js';

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
    mocks.getAuthorizationFingerprint.mockResolvedValue('user_epoch_primary:1');
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
    mocks.getAuthorizationFingerprint.mockResolvedValue('user_epoch_primary:2');

    await requireAuth(makeRequest(cookie), makeResponse(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when the epoch lookup fails rather than serving unconfirmed state', async () => {
    const cookie = `sealed-lookup-error-${Date.now()}`;
    const next = vi.fn() as NextFunction;

    await requireAuth(makeRequest(cookie), makeResponse(), next);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);

    mocks.getAuthorizationFingerprint.mockRejectedValueOnce(new Error('db down'));

    await requireAuth(makeRequest(cookie), makeResponse(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
  });
});
