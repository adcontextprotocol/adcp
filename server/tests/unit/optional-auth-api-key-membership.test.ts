import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  checkPlatformBan: vi.fn(),
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
      apiKeys: {
        createValidation: mocks.createValidation,
      },
    };
  }),
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBanForApiKey: mocks.checkPlatformBanForApiKey,
    checkPlatformBan: mocks.checkPlatformBan,
  },
}));

import { optionalAuth } from '../../src/middleware/auth.js';

describe('optionalAuth WorkOS API keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false, ban: null });
  });

  it('authenticates the API key without granting AAO membership', async () => {
    mocks.createValidation.mockResolvedValue({
      apiKey: {
        id: 'key_123',
        owner: { id: 'org_free_tier' },
        name: 'Free tier API key',
        permissions: [],
      },
    });
    const req = {
      headers: { authorization: 'Bearer sk_test_free_tier' },
      path: '/api/certification/modules/paid-module',
    } as Request & { apiKey?: unknown };
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({
      id: 'api_key_key_123',
      email: 'api-key@org-org_free_tier',
      firstName: 'API',
      lastName: 'Free tier API key',
    });
    expect(req.accessToken).toBe('workos-api-key');
    expect(req.apiKey).toMatchObject({
      id: 'key_123',
      organizationId: 'org_free_tier',
      permissions: [],
    });
    expect((req.user as unknown as { isMember?: boolean }).isMember).toBeUndefined();
  });
});
