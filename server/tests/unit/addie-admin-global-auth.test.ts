import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  loadSealedSession: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  checkPlatformBan: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
  getAdminWorkingGroupBySlug: vi.fn(),
  isAdminGroupMember: vi.fn(),
  poolQuery: vi.fn(),
  getWebConversations: vi.fn(),
  serveHtmlWithConfig: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_global_boundary';
  process.env.WORKOS_CLIENT_ID = 'client_test_global_boundary';
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
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));

vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: () => ({ query: mocks.poolQuery }),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class WorkingGroupDatabase {
    getWorkingGroupBySlug = mocks.getAdminWorkingGroupBySlug;
    isMember = mocks.isAdminGroupMember;
  },
}));

vi.mock('../../src/addie/mcp/admin-tools.js', async () => {
  const { isWebUserAAOAdmin } = await import(
    '../../src/addie/admin-status-lookup.js'
  );
  return { isWebUserAAOAdmin };
});

vi.mock('../../src/db/addie-db.js', () => ({
  AddieDatabase: class AddieDatabase {
    getWebConversations = mocks.getWebConversations;
  },
}));

vi.mock('../../src/utils/html-config.js', () => ({
  serveHtmlWithConfig: mocks.serveHtmlWithConfig,
}));

const { createAddieAdminRouter } = await import('../../src/routes/addie-admin.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');
const { csrfProtection } = await import('../../src/middleware/csrf.js');

function createApp() {
  const app = express();
  // Test fixture installs the real custom CSRF middleware immediately below.
  // codeql[js/missing-token-validation]
  app.use(cookieParser());
  app.use(csrfProtection);
  const { pageRouter, apiRouter } = createAddieAdminRouter();
  app.use('/admin/addie', pageRouter);
  app.use('/api/admin/addie', apiRouter);
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

describe('Addie real global-admin boundary', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createValidation.mockImplementation(
      ({ value }: { value: string }) => Promise.resolve(
        validatedTenantKey(value.includes('read') ? 'admin:read' : 'admin:*'),
      ),
    );
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false });
    mocks.checkPlatformBan.mockResolvedValue({ banned: false });
    mocks.getAdminWorkingGroupBySlug.mockResolvedValue({
      id: 'wg_aao_admin',
      slug: 'aao-admin',
    });
    mocks.isAdminGroupMember.mockResolvedValue(true);
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
    mocks.getWebConversations.mockResolvedValue([]);
    mocks.serveHtmlWithConfig.mockImplementation(
      (_req: express.Request, res: express.Response) => {
        res.status(200).send('Addie admin');
        return Promise.resolve();
      },
    );
  });

  it.each(['admin:*', 'admin:read'] as const)(
    'refuses a tenant key with %s before the Addie conversation query',
    async (permission) => {
      const response = await request(app)
        .get('/api/admin/addie/conversations')
        .set('Authorization', `Bearer sk_tenant_${permission === 'admin:read' ? 'read' : 'full'}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.getWebConversations).not.toHaveBeenCalled();
    },
  );

  it.each(['admin:*', 'admin:read'] as const)(
    'refuses a tenant key with %s before serving the Addie admin page',
    async (permission) => {
      const response = await request(app)
        .get('/admin/addie/')
        .set('Accept', 'text/html')
        .set('Authorization', `Bearer sk_tenant_${permission === 'admin:read' ? 'read' : 'full'}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.serveHtmlWithConfig).not.toHaveBeenCalled();
    },
  );

  it('allows a static global admin key to reach the Addie page', async () => {
    const response = await request(app)
      .get('/admin/addie/')
      .set('Accept', 'text/html')
      .set('Authorization', 'Bearer static-global-admin-key');

    expect(response.status).toBe(200);
    expect(mocks.serveHtmlWithConfig).toHaveBeenCalledOnce();
  });

  it('allows an SSO aao-admin to reach the Addie conversation API', async () => {
    const response = await request(app)
      .get('/api/admin/addie/conversations')
      .set('Cookie', 'wos-session=valid-sso-admin-session');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ conversations: [], total: 0 });
    expect(mocks.getAdminWorkingGroupBySlug).toHaveBeenCalledWith('aao-admin');
    expect(mocks.isAdminGroupMember).toHaveBeenCalledWith(
      'wg_aao_admin',
      'user_sso_admin',
    );
    expect(mocks.getWebConversations).toHaveBeenCalledOnce();
  });
});

afterAll(() => {
  stopAuthTimers();
});
