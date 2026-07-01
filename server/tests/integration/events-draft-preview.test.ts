import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// WorkOS mock — must be registered before any module that reads from it.
vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      getUser: vi.fn().mockResolvedValue({ id: 'user_evt_admin', email: 'evt-admin@example.com', firstName: 'Evt', lastName: 'Admin' }),
      listUsers: vi.fn().mockResolvedValue({ data: [], listMetadata: {} }),
    },
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: 'org_test', name: 'Test Org' }),
    },
  },
}));

const authState = {
  userId: 'user_evt_admin',
  email: 'evt-admin@example.com',
  authed: true,
};

vi.mock('../../src/middleware/auth.js', () => {
  const setTestUser = (req: any) => {
    if (!authState.authed) return;
    req.user = { id: authState.userId, email: authState.email, firstName: 'Evt' };
  };
  const passthrough = (_req: any, _res: any, next: any) => next();
  const requireAuthMock = (req: any, _res: any, next: any) => { setTestUser(req); next(); };
  return {
    requireAuth: requireAuthMock,
    requireAdmin: passthrough,
    optionalAuth: (req: any, _res: any, next: any) => { setTestUser(req); next(); },
    requireCompanyAccess: passthrough,
    requireActiveSubscription: passthrough,
    requireSignedAgreement: passthrough,
    requireRole: () => passthrough,
    createRequireWorkingGroupLeader: () => passthrough,
    createRequireWorkingGroupMember: () => passthrough,
    refuseCrossTenantAdminApiKey: () => false,
    refuseAnyApiKeyOnGlobalAdmin: () => false,
    requireGlobalAdmin: [requireAuthMock, passthrough, passthrough],
    invalidateSessionCache: vi.fn(),
    invalidateBanCache: vi.fn(),
    invalidateSessionsForUsers: vi.fn(),
    isDevModeEnabled: () => false,
    getDevUser: () => null,
    getAvailableDevUsers: () => ({}),
    getDevSessionCookieName: () => 'dev_session',
    DEV_USERS: {},
  };
});

vi.mock('../../src/mcp/routes.js', () => ({
  configureMCPRoutes: vi.fn(),
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

const adminState = { isAdmin: false };
vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isWebUserAAOAdmin: vi.fn(async () => adminState.isAdmin),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
  createEventSponsorshipProduct: vi.fn().mockResolvedValue(null),
  createCheckoutSession: vi.fn().mockResolvedValue(null),
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

describe('GET /api/events/:slug — draft preview for admins (#2536)', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const USER_ID = 'user_evt_admin';
  const DRAFT_SLUG = 'evt-draft-preview-test';
  const OLD_DRAFT_SLUG = 'evt-draft-preview-old-test';

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name)
       VALUES ($1, 'evt-admin@example.com', 'Evt', 'Admin')
       ON CONFLICT (workos_user_id) DO NOTHING`,
      [USER_ID]
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM event_slug_redirects WHERE old_slug = $1`, [OLD_DRAFT_SLUG]);
    await pool.query(`DELETE FROM events WHERE slug = $1`, [DRAFT_SLUG]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [USER_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    adminState.isAdmin = false;
    authState.authed = true;
    await pool.query(`DELETE FROM event_slug_redirects WHERE old_slug = $1`, [OLD_DRAFT_SLUG]);
    await pool.query(`DELETE FROM events WHERE slug = $1`, [DRAFT_SLUG]);
    const eventResult = await pool.query<{ id: string }>(
      `INSERT INTO events (slug, title, start_time, status, visibility, event_format, event_type)
       VALUES ($1, 'Draft Event', NOW() + INTERVAL '7 days', 'draft', 'public', 'in_person', 'summit')
       RETURNING id`,
      [DRAFT_SLUG]
    );
    await pool.query(
      `INSERT INTO event_slug_redirects (old_slug, event_id)
       VALUES ($1, $2)`,
      [OLD_DRAFT_SLUG, eventResult.rows[0].id]
    );
  });

  it('returns 404 for anonymous viewers of a draft event', async () => {
    authState.authed = false;
    await request(app).get(`/api/events/${DRAFT_SLUG}`).expect(404);
  });

  it('returns 404 for signed-in non-admins of a draft event', async () => {
    authState.authed = true;
    adminState.isAdmin = false;
    await request(app).get(`/api/events/${DRAFT_SLUG}`).expect(404);
  });

  it('lets admins preview a draft event and flags it with draft_preview=true', async () => {
    authState.authed = true;
    adminState.isAdmin = true;

    const response = await request(app).get(`/api/events/${DRAFT_SLUG}`).expect(200);
    expect(response.body.event.slug).toBe(DRAFT_SLUG);
    expect(response.body.event.status).toBe('draft');
    expect(response.body.draft_preview).toBe(true);
  });

  it('does not reveal draft events through old slug redirects to anonymous viewers', async () => {
    authState.authed = false;

    const response = await request(app).get(`/api/events/${OLD_DRAFT_SLUG}`).expect(404);
    expect(response.headers.location).toBeUndefined();
  });

  it('lets admins preview a draft through an old slug without redirecting', async () => {
    authState.authed = true;
    adminState.isAdmin = true;

    const response = await request(app).get(`/api/events/${OLD_DRAFT_SLUG}`).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.body.event.slug).toBe(DRAFT_SLUG);
    expect(response.body.draft_preview).toBe(true);
  });

  it('redirects old slugs only after public visibility checks pass', async () => {
    authState.authed = false;
    await pool.query(
      `UPDATE events SET status = 'published', visibility = 'public' WHERE slug = $1`,
      [DRAFT_SLUG]
    );

    const response = await request(app).get(`/api/events/${OLD_DRAFT_SLUG}`).expect(301);
    expect(response.headers.location).toBe(`/api/events/${DRAFT_SLUG}`);
  });
});
