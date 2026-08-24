import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  epoch: 1,
  identityId: 'identity_epoch_test',
  checkPlatformBan: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_authorization_epoch';
  process.env.WORKOS_CLIENT_ID ??= 'client_test_authorization_epoch';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars';
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return { apiKeys: { createValidation: vi.fn().mockResolvedValue({ apiKey: null }) } };
  }),
}));

vi.mock('../../src/auth/workos-jwt.js', () => ({
  looksLikeJWT: () => true,
  verifyWorkOSJWT: vi.fn().mockResolvedValue({
    sub: 'user_epoch_test',
    email: 'epoch@test.example',
    exp: Math.floor(Date.now() / 1000) + 3600,
    isM2M: false,
  }),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBan: mocks.checkPlatformBan,
    checkPlatformBanForApiKey: vi.fn(),
  },
}));

vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: vi.fn(),
}));

import { requireAuth, stopAuthTimers } from '../../src/middleware/auth.js';

function requestForToken(): Request {
  return {
    headers: { authorization: 'Bearer header.payload.signature' },
    path: '/api/organizations/org_selected',
    originalUrl: '/api/organizations/org_selected',
    accepts: () => false,
  } as unknown as Request;
}

function responseRecorder(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  } as Response & { statusCode?: number; body?: unknown };
  return res;
}

describe('persisted identity authorization epoch', () => {
  afterAll(() => stopAuthTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch = 1;
    mocks.identityId = 'identity_epoch_test';
    mocks.checkPlatformBan.mockResolvedValue({ banned: false, ban: null });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users WHERE workos_user_id')) {
        return {
          rowCount: 1,
          rows: [{ first_name: 'Epoch', last_name: 'Test', email: 'epoch@test.example' }],
        };
      }
      if (sql.includes('FROM identity_workos_users iwu')) {
        return {
          rowCount: 1,
          rows: [{
            identity_id: mocks.identityId,
            primary_workos_user_id: 'user_epoch_test',
            identity_authorization_epoch: mocks.epoch,
            credential_authorization_epoch: 1,
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it('rejects one cached replay after the persisted epoch changes', async () => {
    const firstReq = requestForToken();
    const firstRes = responseRecorder();
    const firstNext = vi.fn() as NextFunction;
    await requireAuth(firstReq, firstRes, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();
    expect(firstReq.user?.authorizationEpoch).toBe('1:1');
    firstReq.user!.isMember = true;

    mocks.epoch = 2;
    const staleReq = requestForToken();
    const staleRes = responseRecorder();
    const staleNext = vi.fn() as NextFunction;
    await requireAuth(staleReq, staleRes, staleNext);
    expect(staleNext).not.toHaveBeenCalled();
    expect(staleRes.statusCode).toBe(401);
    expect(staleRes.body).toMatchObject({ error: 'Authorization state changed' });
    expect(staleReq.user?.isMember).toBeUndefined();

    // The cached principal now carries the current epoch. A retry proceeds,
    // but it cannot reuse authority from the pre-change request.
    const retryReq = requestForToken();
    const retryRes = responseRecorder();
    const retryNext = vi.fn() as NextFunction;
    await requireAuth(retryReq, retryRes, retryNext);
    expect(retryNext).toHaveBeenCalledOnce();
    expect(retryReq.user?.authorizationEpoch).toBe('2:1');
  });

  it('rejects a cached replay when the binding moves to an identity with the same epoch', async () => {
    const firstReq = requestForToken();
    await requireAuth(firstReq, responseRecorder(), vi.fn() as NextFunction);
    expect(firstReq.user).toMatchObject({
      identityId: 'identity_epoch_test',
      authorizationEpoch: '1:1',
    });
    firstReq.user!.isMember = true;

    mocks.identityId = 'identity_epoch_collision';
    const staleReq = requestForToken();
    const staleRes = responseRecorder();
    const staleNext = vi.fn() as NextFunction;
    await requireAuth(staleReq, staleRes, staleNext);

    expect(staleNext).not.toHaveBeenCalled();
    expect(staleRes.statusCode).toBe(401);
    expect(staleRes.body).toMatchObject({ error: 'Authorization state changed' });
    expect(staleReq.user?.isMember).toBeUndefined();

    const retryReq = requestForToken();
    const retryNext = vi.fn() as NextFunction;
    await requireAuth(retryReq, responseRecorder(), retryNext);
    expect(retryNext).toHaveBeenCalledOnce();
    expect(retryReq.user).toMatchObject({
      identityId: 'identity_epoch_collision',
      authorizationEpoch: '1:1',
    });
  });
});
