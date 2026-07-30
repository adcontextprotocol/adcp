import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getProfileById: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  invalidateMemberContextCache: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_profile_tenant_boundary';
  process.env.WORKOS_CLIENT_ID = 'client_test_profile_tenant_boundary';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();

  return {
    ...actual,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        id: 'user_profile_boundary',
        email: 'profile-boundary@example.test',
        emailVerified: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };

      const apiKeyOrgId = req.header('x-test-api-key-org-id');
      if (apiKeyOrgId) {
        (req as Request & {
          apiKey?: {
            id: string;
            organizationId: string;
            name: string;
            permissions: string[];
          };
        }).apiKey = {
          id: 'apikey_profile_automation',
          organizationId: apiKeyOrgId,
          name: 'Profile automation',
          permissions: [req.header('x-test-api-key-permission') ?? 'admin:*'],
        };
      }
      if (req.header('x-test-static-admin') === '1') {
        (req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey = true;
      }
      next();
    },
  };
});

const { createAdminMemberProfileRouter } = await import('../../src/routes/member-profiles.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');

const profile = {
  id: 'profile_target',
  workos_organization_id: 'org_owner',
  display_name: 'Acme Corp',
};

const memberDb = {
  getProfileById: (...args: unknown[]) => mocks.getProfileById(...args),
  updateProfile: (...args: unknown[]) => mocks.updateProfile(...args),
  deleteProfile: (...args: unknown[]) => mocks.deleteProfile(...args),
};

const app = express();
app.use(express.json());
app.use(
  '/api/admin/member-profiles',
  createAdminMemberProfileRouter({
    workos: null,
    memberDb,
    brandDb: {},
    orgDb: {},
    invalidateMemberContextCache: mocks.invalidateMemberContextCache,
  } as unknown as Parameters<typeof createAdminMemberProfileRouter>[0]),
);

afterAll(() => {
  stopAuthTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProfileById.mockResolvedValue(profile);
  mocks.updateProfile.mockResolvedValue({ ...profile, tagline: 'Updated' });
  mocks.deleteProfile.mockResolvedValue(true);
});

function mutateProfile(
  method: 'put' | 'delete',
  apiKeyOrgId: string,
  permission = 'admin:*',
) {
  const pendingRequest = method === 'put'
    ? request(app)
      .put(`/api/admin/member-profiles/${profile.id}`)
      .send({ tagline: 'Updated' })
    : request(app).delete(`/api/admin/member-profiles/${profile.id}`);

  return pendingRequest
    .set('x-test-api-key-org-id', apiKeyOrgId)
    .set('x-test-api-key-permission', permission);
}

describe('member profile platform-admin boundary', () => {
  it.each(['put', 'delete'] as const)(
    'refuses same-tenant admin:* automation before it can %s its own profile',
    async (method) => {
      const response = await mutateProfile(method, 'org_owner');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.getProfileById).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
      expect(mocks.deleteProfile).not.toHaveBeenCalled();
      expect(mocks.invalidateMemberContextCache).not.toHaveBeenCalled();
    },
  );

  it.each(['put', 'delete'] as const)(
    'keeps the %s route available to the static platform-admin key',
    async (method) => {
      const pendingRequest = method === 'put'
        ? request(app)
          .put(`/api/admin/member-profiles/${profile.id}`)
          .send({ tagline: 'Updated' })
        : request(app).delete(`/api/admin/member-profiles/${profile.id}`);
      const response = await pendingRequest.set('x-test-static-admin', '1');

      expect(response.status).toBe(200);
      expect(mocks.getProfileById).toHaveBeenCalledOnce();
      if (method === 'put') {
        expect(mocks.updateProfile).toHaveBeenCalledWith(profile.id, { tagline: 'Updated' });
      } else {
        expect(mocks.deleteProfile).toHaveBeenCalledWith(profile.id);
      }
      expect(mocks.invalidateMemberContextCache).toHaveBeenCalledOnce();
    },
  );

  it('returns not found without mutation for a platform admin when the profile does not exist', async () => {
    mocks.getProfileById.mockResolvedValueOnce(null);

    const response = await request(app)
      .put(`/api/admin/member-profiles/${profile.id}`)
      .set('x-test-static-admin', '1')
      .send({ tagline: 'Updated' });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Profile not found');
    expect(mocks.getProfileById).toHaveBeenCalledOnce();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(mocks.deleteProfile).not.toHaveBeenCalled();
    expect(mocks.invalidateMemberContextCache).not.toHaveBeenCalled();
  });

  it.each(['put', 'delete'] as const)(
    'refuses cross-tenant admin:* automation before it can %s a sibling profile',
    async (method) => {
      const response = await mutateProfile(method, 'org_sibling');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.getProfileById).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
      expect(mocks.deleteProfile).not.toHaveBeenCalled();
      expect(mocks.invalidateMemberContextCache).not.toHaveBeenCalled();
    },
  );

  it.each(['put', 'delete'] as const)(
    'refuses same-tenant admin:read automation before a %s write',
    async (method) => {
      const response = await mutateProfile(method, 'org_owner', 'admin:read');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.getProfileById).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
      expect(mocks.deleteProfile).not.toHaveBeenCalled();
      expect(mocks.invalidateMemberContextCache).not.toHaveBeenCalled();
    },
  );
});
