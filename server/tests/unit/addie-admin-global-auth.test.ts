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
  getAdminWorkingGroupBySlug: vi.fn(),
  isAdminGroupMember: vi.fn(),
  poolQuery: vi.fn(),
  getWebConversations: vi.fn(),
  getModelExecutionReadiness: vi.fn(),
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
  invalidateMembershipCache: mocks.invalidateMembershipCache,
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

vi.mock('../../src/addie/model-execution-readiness.js', () => ({
  getModelExecutionReadiness: mocks.getModelExecutionReadiness,
}));

vi.mock('../../src/utils/html-config.js', () => ({
  serveHtmlWithConfig: mocks.serveHtmlWithConfig,
}));

const { createAddieAdminRouter } = await import('../../src/routes/addie-admin.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');
const { csrfProtection } = await import('../../src/middleware/csrf.js');

function createApp() {
  const app = express();
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
    mocks.getModelExecutionReadiness.mockResolvedValue({
      scope: 'persisted_provenance_data',
      limitations: [
        'requires_deployment_drain_confirmation',
        'does_not_measure_failed_database_writes',
        'not_a_provider_canary_gate',
      ],
      window: {
        start: '2026-08-24T00:00:00.000Z',
        end: '2026-08-25T00:00:00.000Z',
        hours: 24,
      },
      minimum_thread_message_samples: 100,
      minimum_interaction_samples: 1,
      surfaces: {
        thread_messages: {
          total: 100, provider: 90, local: 10, unclassified: 0, legacy: 0,
          invalid: 0, fallback: 0, canonicalized: 0, classification_rate: 1,
          persisted_data_ready: true, blockers: [],
        },
        interactions: {
          total: 5, provider: 5, local: 0, unclassified: 0, legacy: 0,
          invalid: 0, fallback: 0, canonicalized: 0, classification_rate: 1,
          persisted_data_ready: true, blockers: [],
        },
      },
      persisted_data_ready: true,
      blockers: [],
    });
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

  it('exposes model execution readiness only through the global-admin boundary', async () => {
    const denied = await request(app)
      .get('/api/admin/addie/threads/model-execution-provenance-readiness?hours=48&minimum_thread_message_samples=200')
      .set('Authorization', 'Bearer sk_tenant_read');
    expect(denied.status).toBe(403);
    expect(mocks.getModelExecutionReadiness).not.toHaveBeenCalled();

    const allowed = await request(app)
      .get('/api/admin/addie/threads/model-execution-provenance-readiness?hours=48&minimum_thread_message_samples=200')
      .set('Authorization', 'Bearer static-global-admin-key');
    expect(allowed.status).toBe(200);
    expect(allowed.body.persisted_data_ready).toBe(true);
    expect(allowed.body.limitations).toContain('not_a_provider_canary_gate');
    expect(mocks.getModelExecutionReadiness).toHaveBeenCalledWith({
      hours: 48,
      minimumSamples: 200,
    });
  });

  it('returns a bounded validation error for malformed readiness windows', async () => {
    mocks.getModelExecutionReadiness.mockRejectedValueOnce(
      new RangeError('hours must be an integer from 1 to 168'),
    );
    const response = await request(app)
      .get('/api/admin/addie/threads/model-execution-provenance-readiness?hours=1abc')
      .set('Authorization', 'Bearer static-global-admin-key');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'hours must be an integer from 1 to 168' });
    expect(mocks.getModelExecutionReadiness).toHaveBeenCalledWith({
      hours: Number.NaN,
      minimumSamples: 100,
    });
  });
});

afterAll(() => {
  stopAuthTimers();
});
