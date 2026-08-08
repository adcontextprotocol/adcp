import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
  listPortraits: vi.fn(),
  getUserPortraitMap: vi.fn(),
  getPortraitById: vi.fn(),
  rejectPortrait: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_portrait_global_boundary';
  process.env.WORKOS_CLIENT_ID = 'client_test_portrait_global_boundary';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
  process.env.ADMIN_API_KEY = 'static-portrait-global-admin-key';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    apiKeys = { createValidation: mocks.createValidation };
  },
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBanForApiKey: mocks.checkPlatformBanForApiKey,
    checkPlatformBan: vi.fn(),
  },
}));

vi.mock('../../src/db/org-filters.js', () => ({
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));

vi.mock('../../src/db/portrait-db.js', () => ({
  listPortraits: (...args: unknown[]) => mocks.listPortraits(...args),
  getUserPortraitMap: (...args: unknown[]) => mocks.getUserPortraitMap(...args),
  getPortraitById: (...args: unknown[]) => mocks.getPortraitById(...args),
  rejectPortrait: (...args: unknown[]) => mocks.rejectPortrait(...args),
  getActivePortraitId: vi.fn(),
  removeFromUser: vi.fn(),
}));

vi.mock('../../src/services/portrait-generator.js', () => ({
  VIBE_OPTIONS: { casual: {} },
  generatePortrait: vi.fn(),
}));

const { createAdminPortraitRouter } = await import('../../src/routes/portraits.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/portraits', createAdminPortraitRouter());
  return app;
}

function validatedTenantKey(permission: 'admin:*' | 'admin:read') {
  return {
    apiKey: {
      id: `key_${permission}`,
      owner: { id: 'org_tenant' },
      name: 'Tenant admin key',
      permissions: [permission],
    },
  };
}

describe('portrait admin route authorization', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createValidation.mockImplementation(
      ({ value }: { value: string }) => Promise.resolve(
        validatedTenantKey(value.includes('read') ? 'admin:read' : 'admin:*'),
      ),
    );
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false });
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });
    mocks.listPortraits.mockResolvedValue([]);
    mocks.getUserPortraitMap.mockResolvedValue({});
    mocks.getPortraitById.mockResolvedValue({ id: 'portrait_1', user_id: null });
    mocks.rejectPortrait.mockResolvedValue(undefined);
  });

  it.each([
    ['GET / with admin:*', 'sk_tenant_full', () => request(app).get('/api/admin/portraits')],
    ['GET / with admin:read', 'sk_tenant_read', () => request(app).get('/api/admin/portraits')],
    ['GET /map with admin:*', 'sk_tenant_full', () => request(app).get('/api/admin/portraits/map')],
    ['GET /map with admin:read', 'sk_tenant_read', () => request(app).get('/api/admin/portraits/map')],
    ['DELETE /:id with admin:*', 'sk_tenant_full', () => request(app).delete('/api/admin/portraits/portrait_1')],
    ['DELETE /:id with admin:read', 'sk_tenant_read', () => request(app).delete('/api/admin/portraits/portrait_1')],
  ])('denies a tenant WorkOS admin key on %s before portrait access', async (_name, apiKey, makeRequest) => {
    const response = await makeRequest()
      .set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('global_admin_required');
    expect(mocks.listPortraits).not.toHaveBeenCalled();
    expect(mocks.getUserPortraitMap).not.toHaveBeenCalled();
    expect(mocks.getPortraitById).not.toHaveBeenCalled();
    expect(mocks.rejectPortrait).not.toHaveBeenCalled();
  });

  it('allows a static global admin key to list portraits', async () => {
    const response = await request(app)
      .get('/api/admin/portraits')
      .set('Authorization', 'Bearer static-portrait-global-admin-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ portraits: [] });
    expect(mocks.listPortraits).toHaveBeenCalledOnce();
  });

  it('allows a static global admin key to read the portrait map', async () => {
    const response = await request(app)
      .get('/api/admin/portraits/map')
      .set('Authorization', 'Bearer static-portrait-global-admin-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
    expect(mocks.getUserPortraitMap).toHaveBeenCalledOnce();
  });

  it('allows a static global admin key to reject a portrait', async () => {
    const response = await request(app)
      .delete('/api/admin/portraits/portrait_1')
      .set('Authorization', 'Bearer static-portrait-global-admin-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mocks.getPortraitById).toHaveBeenCalledWith('portrait_1');
    expect(mocks.rejectPortrait).toHaveBeenCalledWith('portrait_1');
  });
});

afterAll(() => {
  stopAuthTimers();
});
