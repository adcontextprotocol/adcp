import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      getUser: vi.fn().mockResolvedValue({ id: 'user_speaker_admin', email: 'speaker-admin@example.com', firstName: 'S', lastName: 'Admin' }),
      listUsers: vi.fn().mockResolvedValue({ data: [], listMetadata: {} }),
    },
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: 'org_test', name: 'Test Org' }),
    },
  },
}));

const authState = {
  userId: 'user_speaker_admin',
  email: 'speaker-admin@example.com',
  authed: true,
};

vi.mock('../../src/middleware/auth.js', () => {
  const setTestUser = (req: any) => {
    if (!authState.authed) return;
    req.user = { id: authState.userId, email: authState.email, firstName: 'S' };
  };
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    requireAuth: (req: any, _res: any, next: any) => { setTestUser(req); next(); },
    requireAdmin: passthrough,
    optionalAuth: (req: any, _res: any, next: any) => { setTestUser(req); next(); },
    requireCompanyAccess: passthrough,
    requireActiveSubscription: passthrough,
    requireSignedAgreement: passthrough,
    requireRole: () => passthrough,
    createRequireWorkingGroupLeader: () => passthrough,
    createRequireWorkingGroupMember: () => passthrough,
    invalidateSessionCache: vi.fn(),
    invalidateBanCache: vi.fn(),
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

vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isWebUserAAOAdmin: vi.fn(async () => true),
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

describe('Event speakers (#2552)', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const USER_ID = 'user_speaker_admin';
  const EVENT_SLUG = 'evt-speakers-test';
  let eventId: string;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name)
       VALUES ($1, 'speaker-admin@example.com', 'S', 'Admin')
       ON CONFLICT (workos_user_id) DO NOTHING`,
      [USER_ID]
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM events WHERE slug = $1`, [EVENT_SLUG]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [USER_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    authState.authed = true;
    await pool.query(`DELETE FROM events WHERE slug = $1`, [EVENT_SLUG]);
    const result = await pool.query(
      `INSERT INTO events (slug, title, start_time, status, visibility, event_format, event_type)
       VALUES ($1, 'Speakers Test', NOW() + INTERVAL '7 days', 'published', 'public', 'in_person', 'summit')
       RETURNING id`,
      [EVENT_SLUG]
    );
    eventId = result.rows[0].id;
  });

  it('admin PUT with speakers saves the roster and returns it in admin GET', async () => {
    await request(app)
      .put(`/api/admin/events/${eventId}`)
      .send({
        title: 'Speakers Test',
        start_time: new Date(Date.now() + 7 * 86400000).toISOString(),
        speakers: [
          { name: 'Alice Bloom', title: 'CEO', company: 'Acme', bio: 'Loves ad tech', headshot_url: 'https://example.com/a.jpg' },
          { name: 'Bob Chen', title: 'CTO', company: 'Acme' },
        ],
      })
      .expect(200);

    const adminRes = await request(app).get(`/api/admin/events/${eventId}`).expect(200);
    expect(adminRes.body.speakers).toHaveLength(2);
    expect(adminRes.body.speakers[0].name).toBe('Alice Bloom');
    expect(adminRes.body.speakers[0].display_order).toBe(0);
    expect(adminRes.body.speakers[1].name).toBe('Bob Chen');
    expect(adminRes.body.speakers[1].display_order).toBe(1);
  });

  it('public GET /api/events/:slug returns speakers in order', async () => {
    await pool.query(
      `INSERT INTO event_speakers (event_id, name, title, display_order) VALUES
       ($1, 'Second', 'Panelist', 1),
       ($1, 'First', 'Keynote', 0)`,
      [eventId]
    );

    const res = await request(app).get(`/api/events/${EVENT_SLUG}`).expect(200);
    expect(res.body.speakers).toHaveLength(2);
    expect(res.body.speakers[0].name).toBe('First');
    expect(res.body.speakers[1].name).toBe('Second');
  });

  it('PUT with empty speakers array clears the roster', async () => {
    await pool.query(
      `INSERT INTO event_speakers (event_id, name, display_order) VALUES ($1, 'to-be-removed', 0)`,
      [eventId]
    );

    await request(app)
      .put(`/api/admin/events/${eventId}`)
      .send({ speakers: [] })
      .expect(200);

    const res = await request(app).get(`/api/events/${EVENT_SLUG}`).expect(200);
    expect(res.body.speakers).toEqual([]);
  });

  it('PUT without a speakers field leaves the roster untouched', async () => {
    await pool.query(
      `INSERT INTO event_speakers (event_id, name, display_order) VALUES ($1, 'keep me', 0)`,
      [eventId]
    );

    await request(app)
      .put(`/api/admin/events/${eventId}`)
      .send({ short_description: 'unrelated update' })
      .expect(200);

    const res = await request(app).get(`/api/events/${EVENT_SLUG}`).expect(200);
    expect(res.body.speakers).toHaveLength(1);
    expect(res.body.speakers[0].name).toBe('keep me');
  });

  it('rejects speakers with missing name', async () => {
    await request(app)
      .put(`/api/admin/events/${eventId}`)
      .send({ speakers: [{ name: '', title: 'oops' }] })
      .expect(400);
  });

  it('rejects speakers with invalid headshot URL', async () => {
    await request(app)
      .put(`/api/admin/events/${eventId}`)
      .send({ speakers: [{ name: 'Alice', headshot_url: 'javascript:alert(1)' }] })
      .expect(400);
  });
});
