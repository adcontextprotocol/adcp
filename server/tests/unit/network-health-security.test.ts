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
  isWebUserAAOAdmin: vi.fn(),
  poolQuery: vi.fn(),
  getNetworkSummaries: vi.fn(),
  getLatestReport: vi.fn(),
  getReportHistory: vi.fn(),
  getTrends: vi.fn(),
  getAlertRule: vi.fn(),
  getAlertHistory: vi.fn(),
  getUnresolvedAlerts: vi.fn(),
  upsertAlertRule: vi.fn(),
  resolveAlert: vi.fn(),
  serveHtmlWithConfig: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_network_health_boundary';
  process.env.WORKOS_CLIENT_ID = 'client_test_network_health_boundary';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
  process.env.ADMIN_API_KEY = 'static-global-admin-key';
  process.env.ADMIN_EMAILS = '';
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

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: mocks.isWebUserAAOAdmin,
}));

vi.mock('../../src/db/network-health-db.js', () => ({
  getNetworkSummaries: mocks.getNetworkSummaries,
  getLatestReport: mocks.getLatestReport,
  getReportHistory: mocks.getReportHistory,
  getTrends: mocks.getTrends,
  getAlertRule: mocks.getAlertRule,
  getAlertHistory: mocks.getAlertHistory,
  getUnresolvedAlerts: mocks.getUnresolvedAlerts,
  upsertAlertRule: mocks.upsertAlertRule,
  resolveAlert: mocks.resolveAlert,
}));

vi.mock('../../src/utils/html-config.js', () => ({
  serveHtmlWithConfig: mocks.serveHtmlWithConfig,
}));

const { createNetworkHealthApiRouter, registerNetworkHealthAdminPage } = await import(
  '../../src/routes/network-health.js'
);
const { stopAuthTimers } = await import('../../src/middleware/auth.js');
const { csrfProtection } = await import('../../src/middleware/csrf.js');

const ALERT_ID = '11111111-1111-4111-8111-111111111111';
const CSRF_TOKEN = 'a'.repeat(64);

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(csrfProtection);
  app.use(express.json());
  app.use('/api/network-health', createNetworkHealthApiRouter());
  const pageRouter = express.Router();
  registerNetworkHealthAdminPage(pageRouter);
  app.use('/admin', pageRouter);
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

function expectNoNetworkHealthQuery() {
  for (const dbCall of [
    mocks.getNetworkSummaries,
    mocks.getLatestReport,
    mocks.getReportHistory,
    mocks.getTrends,
    mocks.getAlertRule,
    mocks.getAlertHistory,
    mocks.getUnresolvedAlerts,
    mocks.upsertAlertRule,
    mocks.resolveAlert,
  ]) {
    expect(dbCall).not.toHaveBeenCalled();
  }
}

function configureSsoSession(isPlatformAdmin: boolean): void {
  mocks.isWebUserAAOAdmin.mockResolvedValue(isPlatformAdmin);
  mocks.loadSealedSession.mockReturnValue({
    authenticate: vi.fn().mockResolvedValue({
      authenticated: true,
      accessToken: 'user-access-token',
      user: {
        id: isPlatformAdmin ? 'user_platform_admin' : 'user_non_admin',
        email: isPlatformAdmin ? 'platform-admin@example.test' : 'user@example.test',
        firstName: isPlatformAdmin ? 'Platform' : 'Regular',
        lastName: isPlatformAdmin ? 'Admin' : 'User',
        emailVerified: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    }),
  });
}

function withSsoAuth<T extends request.Test>(test: T, platformAdmin = false): T {
  const session = platformAdmin ? 'platform-admin-session' : 'non-admin-session';
  return test
    .set('Cookie', `wos-session=${session}; csrf-token=${CSRF_TOKEN}`)
    .set('X-CSRF-Token', CSRF_TOKEN) as T;
}

function withCsrf<T extends request.Test>(test: T): T {
  return test
    .set('Cookie', `csrf-token=${CSRF_TOKEN}`)
    .set('X-CSRF-Token', CSRF_TOKEN) as T;
}

describe('network-health global authorization boundary', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createValidation.mockImplementation(({ value }: { value: string }) =>
      Promise.resolve(
        validatedTenantKey(value.includes('read') ? 'admin:read' : 'admin:*'),
      ),
    );
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false });
    mocks.checkPlatformBan.mockResolvedValue({ banned: false });
    mocks.isWebUserAAOAdmin.mockResolvedValue(false);
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM users')) {
        return Promise.resolve({
          rows: [{ first_name: 'Regular', last_name: 'User' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mocks.getNetworkSummaries.mockResolvedValue([]);
    mocks.getLatestReport.mockResolvedValue({ id: 'report_1' });
    mocks.getReportHistory.mockResolvedValue([{ id: 'report_history_1' }]);
    mocks.getTrends.mockResolvedValue([{ checked_at: '2026-01-01' }]);
    mocks.getAlertRule.mockResolvedValue({
      id: 'rule_1',
      org_id: 'org_target',
      enabled: true,
      slack_webhook_url: 'https://hooks.slack.com/services/secret/path',
    });
    mocks.getAlertHistory.mockResolvedValue([{ id: 'alert_history_1' }]);
    mocks.getUnresolvedAlerts.mockResolvedValue([{ id: 'alert_open_1' }]);
    mocks.upsertAlertRule.mockResolvedValue({
      id: 'rule_1',
      org_id: 'org_target',
      enabled: true,
      slack_webhook_url: 'https://hooks.slack.com/services/secret/path',
    });
    mocks.resolveAlert.mockResolvedValue(true);
    mocks.serveHtmlWithConfig.mockImplementation(
      (_req: express.Request, res: express.Response) => {
        res.status(200).send('Network health admin');
        return Promise.resolve();
      },
    );
  });

  function endpointsFor(orgId: string) {
    return [
      { method: 'get', path: '/api/network-health' },
      { method: 'get', path: `/api/network-health/${orgId}` },
      { method: 'get', path: `/api/network-health/${orgId}/history` },
      { method: 'get', path: `/api/network-health/${orgId}/trends` },
      { method: 'get', path: `/api/network-health/${orgId}/alerts` },
      { method: 'get', path: `/api/network-health/${orgId}/alerts/history` },
      { method: 'get', path: `/api/network-health/${orgId}/alerts/unresolved` },
      { method: 'post', path: `/api/network-health/${orgId}/alerts`, body: { enabled: true } },
      {
        method: 'post',
        path: `/api/network-health/${orgId}/alerts/${ALERT_ID}/resolve`,
        body: {},
      },
    ] as const;
  }

  const positiveEndpoints = [
    { method: 'get', path: '/api/network-health', db: mocks.getNetworkSummaries, args: [] },
    { method: 'get', path: '/api/network-health/org_target', db: mocks.getLatestReport, args: ['org_target'] },
    { method: 'get', path: '/api/network-health/org_target/history', db: mocks.getReportHistory, args: ['org_target', 30] },
    { method: 'get', path: '/api/network-health/org_target/trends', db: mocks.getTrends, args: ['org_target', 60] },
    { method: 'get', path: '/api/network-health/org_target/alerts', db: mocks.getAlertRule, args: ['org_target'] },
    { method: 'get', path: '/api/network-health/org_target/alerts/history', db: mocks.getAlertHistory, args: ['org_target', 50] },
    { method: 'get', path: '/api/network-health/org_target/alerts/unresolved', db: mocks.getUnresolvedAlerts, args: ['org_target'] },
    { method: 'post', path: '/api/network-health/org_target/alerts', body: { enabled: true }, db: mocks.upsertAlertRule },
    {
      method: 'post',
      path: `/api/network-health/org_target/alerts/${ALERT_ID}/resolve`,
      body: {},
      db: mocks.resolveAlert,
      args: ['org_target', ALERT_ID],
    },
  ] as const;

  it.each([
    ['admin:*', 'org_tenant'],
    ['admin:*', 'org_foreign'],
    ['admin:read', 'org_tenant'],
    ['admin:read', 'org_foreign'],
  ] as const)(
    'rejects a tenant key with %s for %s before every network-health query',
    async (permission, orgId) => {
      for (const endpoint of endpointsFor(orgId)) {
        vi.clearAllMocks();
        mocks.createValidation.mockResolvedValue(validatedTenantKey(permission));
        mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });
        mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false });

        const response = await request(app)
          [endpoint.method](endpoint.path)
          .set('Authorization', `Bearer sk_tenant_${permission}`)
          .send('body' in endpoint ? endpoint.body : undefined);

        expect(response.status, endpoint.path).toBe(403);
        expect(response.body.error, endpoint.path).toBe('global_admin_required');
        expectNoNetworkHealthQuery();
      }
    },
  );

  it('rejects unauthenticated callers before every network-health query', async () => {
    for (const endpoint of endpointsFor('org_target')) {
      vi.clearAllMocks();
      const response = await withCsrf(request(app)
        [endpoint.method](endpoint.path)
        .set('Accept', 'application/json')
        .send('body' in endpoint ? endpoint.body : undefined));

      expect(response.status, endpoint.path).toBe(401);
      expectNoNetworkHealthQuery();
    }
  });

  it('rejects an authenticated non-platform SSO user before every network-health query', async () => {
    // Organization membership is deliberately not an authorization input for
    // this platform-global surface; only platform-admin status is consulted.
    configureSsoSession(false);
    for (const endpoint of endpointsFor('org_target')) {
      vi.clearAllMocks();
      const test = request(app)[endpoint.method](endpoint.path).send(
        'body' in endpoint ? endpoint.body : undefined,
      );
      const response = await withSsoAuth(test);

      expect(response.status, endpoint.path).toBe(403);
      expect(response.body.error, endpoint.path).toBe('Admin access required');
      expectNoNetworkHealthQuery();
    }
  });

  it('allows an SSO platform admin through every API path with exact scoped DB arguments', async () => {
    configureSsoSession(true);
    for (const endpoint of positiveEndpoints) {
      vi.clearAllMocks();
      const test = request(app)[endpoint.method](endpoint.path).send(
        'body' in endpoint ? endpoint.body : undefined,
      );
      const response = await withSsoAuth(test, true);

      expect(response.status, endpoint.path).toBe(200);
      expect(endpoint.db, endpoint.path).toHaveBeenCalledOnce();
      if ('args' in endpoint) {
        expect(endpoint.db.mock.calls[0], endpoint.path).toEqual(endpoint.args);
      } else {
        expect(mocks.upsertAlertRule).toHaveBeenCalledWith(
          expect.objectContaining({
            org_id: 'org_target',
            enabled: true,
            created_by: 'platform-admin@example.test',
          }),
        );
      }
      if (endpoint.path.endsWith('/alerts')) {
        expect(response.body.slack_webhook_url).toBeUndefined();
        expect(response.body.slack_webhook_configured).toBe(true);
      }
    }
  });

  it('allows a global static admin to read the cross-organization summary', async () => {
    const response = await request(app)
      .get('/api/network-health')
      .set('Authorization', 'Bearer static-global-admin-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ networks: [] });
    expect(mocks.getNetworkSummaries).toHaveBeenCalledOnce();
  });

  it('binds alert resolution to both route organization and alert ID', async () => {
    const response = await request(app)
      .post(`/api/network-health/org_target/alerts/${ALERT_ID}/resolve`)
      .set('Authorization', 'Bearer static-global-admin-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(mocks.resolveAlert).toHaveBeenCalledWith('org_target', ALERT_ID);
  });

  it('returns the same 404 when the org-bound alert update finds no row', async () => {
    mocks.resolveAlert.mockResolvedValue(false);

    const response = await request(app)
      .post(`/api/network-health/org_other/alerts/${ALERT_ID}/resolve`)
      .set('Authorization', 'Bearer static-global-admin-key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Alert not found' });
    expect(mocks.resolveAlert).toHaveBeenCalledWith('org_other', ALERT_ID);
  });

  it('rejects malformed alert IDs without calling the update', async () => {
    const response = await request(app)
      .post('/api/network-health/org_target/alerts/not-a-uuid/resolve')
      .set('Authorization', 'Bearer static-global-admin-key');

    expect(response.status).toBe(400);
    expect(mocks.resolveAlert).not.toHaveBeenCalled();
  });

  it.each(['admin:*', 'admin:read'] as const)(
    'rejects a tenant key with %s before serving the admin page',
    async (permission) => {
      mocks.createValidation.mockResolvedValue(validatedTenantKey(permission));
      const response = await request(app)
        .get('/admin/network-health')
        .set('Accept', 'text/html')
        .set('Authorization', `Bearer sk_tenant_${permission}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('global_admin_required');
      expect(mocks.serveHtmlWithConfig).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-platform SSO user before serving the admin page', async () => {
    configureSsoSession(false);
    const response = await withSsoAuth(
      request(app).get('/admin/network-health').set('Accept', 'application/json'),
    );

    expect(response.status).toBe(403);
    expect(mocks.serveHtmlWithConfig).not.toHaveBeenCalled();
  });

  it('allows SSO and static platform admins to serve the admin page', async () => {
    configureSsoSession(true);
    const ssoResponse = await withSsoAuth(
      request(app).get('/admin/network-health').set('Accept', 'text/html'),
      true,
    );
    expect(ssoResponse.status).toBe(200);
    expect(mocks.serveHtmlWithConfig).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    const staticResponse = await request(app)
      .get('/admin/network-health')
      .set('Accept', 'text/html')
      .set('Authorization', 'Bearer static-global-admin-key');
    expect(staticResponse.status).toBe(200);
    expect(mocks.serveHtmlWithConfig).toHaveBeenCalledOnce();
  });
});

afterAll(() => {
  stopAuthTimers();
});
