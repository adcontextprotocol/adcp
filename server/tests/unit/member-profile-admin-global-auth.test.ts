import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
  listProfiles: vi.fn(),
  getProfileById: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_member_profile_global_boundary';
  process.env.WORKOS_CLIENT_ID = 'client_test_member_profile_global_boundary';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
  process.env.ADMIN_API_KEY = 'static-member-profile-global-admin-key';
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

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));

const { createAdminMemberProfileRouter } = await import(
  '../../src/routes/member-profiles.js'
);
const { stopAuthTimers } = await import('../../src/middleware/auth.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/member-profiles', createAdminMemberProfileRouter({
    memberDb: {
      listProfiles: mocks.listProfiles,
      getProfileById: mocks.getProfileById,
      updateProfile: mocks.updateProfile,
    },
    brandDb: {},
    orgDb: {},
    invalidateMemberContextCache: vi.fn(),
  } as any));
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

describe('member profile admin route authorization', () => {
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
    mocks.listProfiles.mockResolvedValue([]);
    mocks.getProfileById.mockResolvedValue({
      id: 'profile_tenant',
      workos_organization_id: 'org_tenant',
    });
    mocks.updateProfile.mockResolvedValue({
      id: 'profile_tenant',
      workos_organization_id: 'org_tenant',
      tagline: 'Tenant-owned update',
    });
  });

  it.each(['admin:*', 'admin:read'] as const)(
    'denies a tenant key with %s before the cross-org profile query',
    async (permission) => {
      const response = await request(app)
        .get('/api/admin/member-profiles')
        .set(
          'Authorization',
          `Bearer sk_tenant_${permission === 'admin:read' ? 'read' : 'full'}`,
        );

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.listProfiles).not.toHaveBeenCalled();
    },
  );

  it('allows the static global admin key to list profiles', async () => {
    const response = await request(app)
      .get('/api/admin/member-profiles')
      .set('Authorization', 'Bearer static-member-profile-global-admin-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ profiles: [] });
    expect(mocks.listProfiles).toHaveBeenCalledOnce();
  });

  it('writes safe profile fields for same-tenant admin keys', async () => {
    const response = await request(app)
      .put('/api/admin/member-profiles/profile_tenant')
      .set('Authorization', 'Bearer sk_tenant_full')
      .send({
        tagline: 'Tenant-owned update',
        linkedin_url: 'https://www.linkedin.com/company/acme-media',
      });

    expect(response.status).toBe(200);
    expect(mocks.getProfileById).toHaveBeenCalledWith('profile_tenant');
    expect(mocks.updateProfile).toHaveBeenCalledWith('profile_tenant', {
      tagline: 'Tenant-owned update',
      linkedin_url: 'https://www.linkedin.com/company/acme-media',
    });
  });
});

afterAll(() => {
  stopAuthTimers();
});
