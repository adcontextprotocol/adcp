import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  loadSealedSession: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  checkPlatformBan: vi.fn(),
  invalidateMembershipCache: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
  poolQuery: vi.fn(),
  listWorkingGroups: vi.fn(),
  addMembership: vi.fn(),
  grantAAOAdminMembership: vi.fn(),
  revokeAAOAdminMembership: vi.fn(),
  getWorkingGroupById: vi.fn(),
  getWorkingGroupBySlug: vi.fn(),
  isMember: vi.fn(),
  updateWorkingGroup: vi.fn(),
  removeMembership: vi.fn(),
  invalidateMemberContextCache: vi.fn(),
  invalidateWebAdminStatusCache: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_working_group_boundary';
  process.env.WORKOS_CLIENT_ID = 'client_test_working_group_boundary';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
  process.env.ADMIN_API_KEY = 'static-global-admin-key';
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
  invalidateMembershipCache: mocks.invalidateMembershipCache,
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));

vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: () => ({ query: mocks.poolQuery }),
}));

vi.mock('../../src/addie/mcp/admin-tools.js', async () => {
  const { isWebUserAAOAdmin } = await import(
    '../../src/addie/admin-status-lookup.js'
  );
  return {
    isWebUserAAOAdmin,
    invalidateWebAdminStatusCache: mocks.invalidateWebAdminStatusCache,
  };
});

vi.mock('../../src/addie/index.js', () => ({
  invalidateMemberContextCache: mocks.invalidateMemberContextCache,
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class WorkingGroupDatabase {
    listWorkingGroups = mocks.listWorkingGroups;
    addMembership = mocks.addMembership;
    grantAAOAdminMembership = mocks.grantAAOAdminMembership;
    revokeAAOAdminMembership = mocks.revokeAAOAdminMembership;
    getWorkingGroupById = mocks.getWorkingGroupById;
    getWorkingGroupBySlug = mocks.getWorkingGroupBySlug;
    isMember = mocks.isMember;
    updateWorkingGroup = mocks.updateWorkingGroup;
    removeMembership = mocks.removeMembership;
  },
}));

const { createCommitteeRouters } = await import('../../src/routes/committees.js');
const { createAAOAdminRouter } = await import('../../src/routes/aao-admin.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');
const { csrfProtection } = await import('../../src/middleware/csrf.js');
const { invalidateWebAdminStatusCache: clearWebAdminStatusCache } = await import('../../src/addie/admin-status-cache.js');

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(csrfProtection);
  app.use(express.json());
  const { adminApiRouter, publicApiRouter } = createCommitteeRouters();
  app.use('/api/admin/working-groups', adminApiRouter);
  app.use('/api/admin/aao-admin', createAAOAdminRouter());
  app.use('/api/working-groups', publicApiRouter);
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

describe('working-group real global-admin boundary', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    clearWebAdminStatusCache();
    mocks.createValidation.mockImplementation(
      ({ value }: { value: string }) => Promise.resolve(
        validatedTenantKey(value.includes('read') ? 'admin:read' : 'admin:*'),
      ),
    );
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false });
    mocks.checkPlatformBan.mockResolvedValue({ banned: false });
    mocks.getWorkingGroupBySlug.mockImplementation((slug: string) =>
      Promise.resolve(slug === 'aao-admin'
        ? { id: 'wg_aao_admin', slug: 'aao-admin' }
        : null),
    );
    mocks.isMember.mockResolvedValue(true);
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM users')) {
        return Promise.resolve({
          rows: [{ first_name: 'SSO', last_name: 'Admin' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mocks.loadSealedSession.mockReturnValue({
      authenticate: vi.fn().mockResolvedValue({
        authenticated: true,
        accessToken: 'sso-access-token',
        user: {
          id: 'user_sso_admin',
          email: 'sso-admin@example.test',
          firstName: 'SSO',
          lastName: 'Admin',
          emailVerified: true,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
    });
    mocks.listWorkingGroups.mockResolvedValue([]);
    mocks.addMembership.mockResolvedValue({
      working_group_id: 'wg_aao_admin',
      workos_user_id: 'user_new_member',
    });
    mocks.getWorkingGroupById.mockResolvedValue(null);
    mocks.grantAAOAdminMembership.mockResolvedValue({ workos_user_id: 'user_new_member' });
    mocks.revokeAAOAdminMembership.mockResolvedValue('user_new_member');
  });

  it.each(['admin:*', 'admin:read'] as const)(
    'refuses a tenant key with %s before listing working groups',
    async (permission) => {
      const response = await request(app)
        .get('/api/admin/working-groups')
        .set('Authorization', `Bearer sk_tenant_${permission === 'admin:read' ? 'read' : 'full'}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.listWorkingGroups).not.toHaveBeenCalled();
    },
  );

  it.each(['admin:*', 'admin:read'] as const)(
    'refuses a tenant key with %s before a dedicated site-admin revoke',
    async (permission) => {
      const response = await request(app)
        .post('/api/admin/aao-admin/revoke')
        .set('Authorization', `Bearer sk_tenant_${permission === 'admin:read' ? 'read' : 'full'}`)
        .send({ workos_user_id: 'user_new_member', reason: 'Offboarding' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.revokeAAOAdminMembership).not.toHaveBeenCalled();
    },
  );

  it.each(['admin:*', 'admin:read'] as const)(
    'refuses a tenant key with %s before a dedicated site-admin grant',
    async (permission) => {
      const response = await request(app)
        .post('/api/admin/aao-admin/grant')
        .set('Authorization', `Bearer sk_tenant_${permission === 'admin:read' ? 'read' : 'full'}`)
        .send({ workos_user_id: 'user_new_member', reason: 'Coverage rotation' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.grantAAOAdminMembership).not.toHaveBeenCalled();
    },
  );

  it.each(['admin:*', 'admin:read'] as const)(
    'refuses a tenant key with %s before adding a member to aao-admin',
    async (permission) => {
      const response = await request(app)
        .post('/api/admin/working-groups/wg_aao_admin/members')
        .set('Authorization', `Bearer sk_tenant_${permission === 'admin:read' ? 'read' : 'full'}`)
        .send({ workos_user_id: 'user_new_member' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.addMembership).not.toHaveBeenCalled();
    },
  );

  it('allows an SSO aao-admin to list working groups', async () => {
    const response = await request(app)
      .get('/api/admin/working-groups')
      .set('Cookie', 'wos-session=valid-sso-admin-session');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mocks.getWorkingGroupBySlug).toHaveBeenCalledWith('aao-admin');
    expect(mocks.isMember).toHaveBeenCalledWith(
      'wg_aao_admin',
      'user_sso_admin',
    );
    expect(mocks.listWorkingGroups).toHaveBeenCalledOnce();
  });

  it('refuses generic membership writes to aao-admin even for a static global admin key', async () => {
    mocks.getWorkingGroupById.mockResolvedValueOnce({ id: 'wg_aao_admin', slug: 'aao-admin' });
    const response = await request(app)
      .post('/api/admin/working-groups/wg_aao_admin/members')
      .set('Authorization', 'Bearer static-global-admin-key')
      .send({ workos_user_id: 'user_new_member' });

    expect(response.status).toBe(405);
    expect(response.body.error).toBe('aao_admin_dedicated_endpoint_required');
    expect(mocks.addMembership).not.toHaveBeenCalled();
  });

  it('refuses generic leader updates to aao-admin even for a static global admin key', async () => {
    mocks.getWorkingGroupById.mockResolvedValueOnce({ id: 'wg_aao_admin', slug: 'aao-admin' });
    const response = await request(app)
      .put('/api/admin/working-groups/wg_aao_admin')
      .set('Authorization', 'Bearer static-global-admin-key')
      .send({ leader_user_ids: ['user_new_member'] });

    expect(response.status).toBe(405);
    expect(response.body.error).toBe('aao_admin_dedicated_endpoint_required');
    expect(mocks.updateWorkingGroup).not.toHaveBeenCalled();
  });

  it('refuses an otherwise authenticated non-admin before a dedicated grant', async () => {
    mocks.isMember.mockResolvedValue(false);
    const csrfToken = 'a'.repeat(64);
    const response = await request(app)
      .post('/api/admin/aao-admin/grant')
      .set('Cookie', [`wos-session=valid-sso-admin-session`, `csrf-token=${csrfToken}`])
      .set('X-CSRF-Token', csrfToken)
      .send({ workos_user_id: 'user_new_member', reason: 'Coverage rotation' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Admin access required');
    expect(mocks.grantAAOAdminMembership).not.toHaveBeenCalled();
  });

  it('refuses self-revocation through the public working-group leave route', async () => {
    const response = await request(app)
      .delete('/api/working-groups/aao-admin/leave')
      .set('Authorization', 'Bearer static-global-admin-key');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('aao_admin_dedicated_endpoint_required');
    expect(mocks.removeMembership).not.toHaveBeenCalled();
  });

  it('rejects an SSO cookie write without a matching CSRF token', async () => {
    const response = await request(app)
      .post('/api/admin/working-groups/wg_aao_admin/members')
      .set('Cookie', 'wos-session=valid-sso-admin-session')
      .send({ workos_user_id: 'user_new_member' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual(expect.objectContaining({
      error: 'CSRF validation failed',
      reason: 'cookie_expired',
    }));
    expect(mocks.addMembership).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  clearWebAdminStatusCache();
  stopAuthTimers();
});
