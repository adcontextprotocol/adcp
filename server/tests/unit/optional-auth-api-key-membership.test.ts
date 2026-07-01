import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  checkPlatformBan: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
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

vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));

import { optionalAuth, requireAuth } from '../../src/middleware/auth.js';

describe('WorkOS API key membership hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false, ban: null });
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: false });
  });

  it('optionalAuth authenticates the API key and applies membership from the owner org', async () => {
    mocks.createValidation.mockResolvedValue({
      apiKey: {
        id: 'key_123',
        owner: { id: 'org_member' },
        name: 'Member API key',
        permissions: [],
      },
    });
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });
    const req = {
      headers: { authorization: 'Bearer sk_test_member' },
      path: '/api/brands/example.com/logos',
    } as Request & { apiKey?: unknown };
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({
      id: 'api_key_key_123',
      email: 'api-key@org-org_member',
      firstName: 'API',
      lastName: 'Member API key',
      isMember: true,
    });
    expect(req.accessToken).toBe('workos-api-key');
    expect(req.apiKey).toMatchObject({
      id: 'key_123',
      organizationId: 'org_member',
      permissions: [],
    });
    expect(mocks.resolveEffectiveMembership).toHaveBeenCalledWith('org_member');
  });

  it('requireAuth authenticates the API key without granting membership to non-member orgs', async () => {
    mocks.createValidation.mockResolvedValue({
      apiKey: {
        id: 'key_456',
        owner: { id: 'org_free_tier' },
        name: 'Free tier API key',
        permissions: [],
      },
    });
    const req = {
      headers: { authorization: 'Bearer sk_test_free_tier' },
      path: '/api/brands/example.com/logos',
      accepts: () => false,
      originalUrl: '/api/brands/example.com/logos',
    } as unknown as Request & { apiKey?: unknown };
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({
      id: 'api_key_key_456',
      email: 'api-key@org-org_free_tier',
      firstName: 'API',
      lastName: 'Free tier API key',
      isMember: false,
    });
    expect(req.accessToken).toBe('workos-api-key');
    expect(req.apiKey).toMatchObject({
      id: 'key_456',
      organizationId: 'org_free_tier',
      permissions: [],
    });
    expect(mocks.resolveEffectiveMembership).toHaveBeenCalledWith('org_free_tier');
  });
});
