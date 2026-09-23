import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ createToken: vi.fn(), info: vi.fn(), auth: vi.fn(), admin: vi.fn() }));
vi.hoisted(() => {
  vi.stubEnv('WORKOS_API_KEY', 'sk_test_widget_containment');
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_test_widget_containment');
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', 'test-cookie-password-at-least-32-characters');
});
vi.mock('@workos-inc/node', () => ({ WorkOS: class WorkOS { widgets = { createToken: mocks.createToken }; } }));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ info: mocks.info, warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    mocks.auth();
    req.user = {
      id: req.get('x-canonical-user') ?? 'user_primary', authWorkosUserId: 'user_linked',
      email: 'caller@example.test', isAdmin: true, emailVerified: true,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    next();
  },
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => { mocks.admin(); next(); },
}));
vi.mock('../../src/db/client.js', () => ({ getPool: vi.fn() }));
vi.mock('../../src/utils/html-config.js', () => ({ serveHtmlWithConfig: vi.fn() }));
vi.mock('../../src/routes/network-health.js', () => ({ registerNetworkHealthAdminPage: vi.fn() }));
vi.mock('../../src/addie/member-context.js', () => ({ getMemberContext: vi.fn(), getWebMemberContext: vi.fn() }));
vi.mock('../../src/db/outbound-db.js', () => ({ getMemberCapabilities: vi.fn() }));
vi.mock('../../src/addie/services/relationship-orchestrator.js', () => ({ canEngageSlackUser: vi.fn() }));
vi.mock('../../src/addie/services/engagement-planner.js', () => ({ computeEngagementOpportunities: vi.fn() }));
vi.mock('../../src/db/relationship-db.js', () => ({}));
vi.mock('../../src/addie/services/relationship-context.js', () => ({ loadRelationshipContext: vi.fn() }));
vi.mock('../../src/routes/admin/prospects.js', () => ({ setupProspectRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/organizations.js', () => ({ setupOrganizationRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/enrichment.js', () => ({ setupEnrichmentRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/domains.js', () => ({ setupDomainRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/cleanup.js', () => ({ setupCleanupRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/stats.js', () => ({ setupStatsRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/discounts.js', () => ({ setupDiscountRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/accounts.js', () => ({ setupAccountRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/accounts-billing.js', () => ({ setupAccountsBillingRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/brand-enrichment.js', () => ({ setupBrandEnrichmentRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/bans.js', () => ({ setupBanRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/geo.js', () => ({ setupGeoRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/announcements.js', () => ({ setupAnnouncementsRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/relationships.js', () => ({ setupRelationshipRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/simulations.js', () => ({ setupSimulationRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/illustrations.js', () => ({ setupIllustrationRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/addie-costs.js', () => ({ setupAddieCostRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/prompt-metrics.js', () => ({ setupPromptMetricsRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/integrity.js', () => ({ setupIntegrityRoutes: vi.fn() }));
vi.mock('../../src/routes/admin/agents.js', () => ({ setupAdminAgentsRoutes: vi.fn() }));
vi.mock('../../src/routes/aao-admin.js', () => ({ createAAOAdminRouter: () => express.Router() }));
vi.mock('../../src/newsletters/registry.js', () => ({ getAllNewsletters: () => [] }));
vi.mock('../../src/newsletters/admin-routes.js', () => ({ createNewsletterAdminRoutes: () => express.Router() }));
vi.mock('../../src/newsletters/the-build/index.js', () => ({}));
vi.mock('../../src/newsletters/the-prompt/index.js', () => ({}));

const { createAdminRouter } = await import('../../src/routes/admin.js');
const app = express();
app.use(express.json());
app.use('/api/admin', createAdminRouter().apiRouter);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createToken.mockResolvedValue('widget_token_supported_scope');
});

describe('API key widget mutation containment', () => {
  it.each([undefined, null, '', false, 'widgets:api-keys:manage'])('refuses API key scope or default %j before issuing a delegation token', async (scope) => {
    const response = await request(app).post('/api/admin/widgets/token').send({ organizationId: 'org_target', scope });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'API key mutations unavailable',
      message: 'API key creation and revocation are disabled until membership changes can be fenced.',
    });
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.admin).toHaveBeenCalledOnce();
    expect(mocks.createToken).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(['admin_api_key', 'api_key_tenant', 'user_platform_admin'])('does not let admin attribution %s reopen the widget mutation path', async (principal) => {
    const response = await request(app).post('/api/admin/widgets/token')
      .set('x-canonical-user', principal).send({ organizationId: 'org_target', scope: 'widgets:api-keys:manage' });
    expect(response.status).toBe(503);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it.each(['widgets:users-table:manage', 'widgets:sso:manage', 'widgets:domain-verification:manage'])('retains existing delegation for supported unrelated scope %s', async (scope) => {
    const response = await request(app).post('/api/admin/widgets/token').send({ organizationId: 'org_target', scope });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ token: 'widget_token_supported_scope' });
    expect(mocks.createToken).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org_target', userId: 'user_linked', scopes: [scope],
    });
  });

  it.each(['widgets:api-keys:MANAGE', ['widgets:api-keys:manage'], 'widgets:api-keys:manage,widgets:sso:manage'])('rejects scope confusion %j without issuing a token', async (scope) => {
    const response = await request(app).post('/api/admin/widgets/token').send({ organizationId: 'org_target', scope });
    expect(response.status).toBe(400);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });
});
