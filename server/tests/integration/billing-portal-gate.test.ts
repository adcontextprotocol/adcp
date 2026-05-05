/**
 * Route-level test for POST /api/organizations/:orgId/billing/portal — the
 * subscription_status gate added so non-subscribers stop landing on an empty
 * Stripe portal session (Sabarish opened it four times before realizing
 * the portal can't initiate a subscription).
 *
 * Confirms the gate refuses NULL but allows past_due / canceled / etc., where
 * the portal IS the right tool to recover the subscription.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const {
  TEST_USER_ID,
  TEST_ORG,
  mockListMemberships,
  mockCreatePortalSession,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    TEST_USER_ID: 'user_portal_test',
    TEST_ORG: 'org_portal_gate_test',
    mockListMemberships: vi.fn().mockResolvedValue({
      data: [{ id: 'om_test', role: { slug: 'owner' }, status: 'active' }],
    }),
    mockCreatePortalSession: vi.fn().mockResolvedValue('https://billing.stripe.com/p/session/x'),
  };
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships: mockListMemberships,
      createOrganizationMembership: vi.fn().mockResolvedValue({ id: 'om_new' }),
      sendInvitation: vi.fn(),
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: 'tester@portal.test' }),
    };
    organizations = {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG, name: 'Portal Test Org' }),
    };
    adminPortal = {
      generateLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
    };
  },
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: mockListMemberships,
      createOrganizationMembership: vi.fn().mockResolvedValue({ id: 'om_new' }),
      sendInvitation: vi.fn(),
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: 'tester@portal.test' }),
    },
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG, name: 'Portal Test Org' }),
    },
    adminPortal: {
      generateLink: vi.fn().mockResolvedValue({ link: 'https://test-portal.workos.com' }),
    },
  },
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'tester@portal.test',
      firstName: 'Portal',
      lastName: 'Tester',
      emailVerified: true,
      is_admin: false,
    };
    next();
  },
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue('cus_test_portal'),
  createCustomerPortalSession: mockCreatePortalSession,
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: mockCreatePortalSession,
}));

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
}

async function seedOrg(pool: Pool, opts: {
  subscriptionStatus?: string | null;
  stripeCustomerId?: string | null;
}) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, subscription_status, stripe_customer_id, created_at, updated_at)
     VALUES ($1, $2, false, $3, $4, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET subscription_status = EXCLUDED.subscription_status,
           stripe_customer_id = EXCLUDED.stripe_customer_id`,
    [TEST_ORG, 'Portal Test Org', opts.subscriptionStatus ?? null, opts.stripeCustomerId ?? 'cus_test_portal'],
  );
}

describe('POST /api/organizations/:orgId/billing/portal — subscription_status gate', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
    mockCreatePortalSession.mockClear();
    mockCreatePortalSession.mockResolvedValue('https://billing.stripe.com/p/session/x');
  });

  it('refuses with 400 + membership_url when subscription_status is NULL (Sabarish case)', async () => {
    await seedOrg(pool, { subscriptionStatus: null });

    const res = await request(app).post(`/api/organizations/${TEST_ORG}/billing/portal`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No subscription on file');
    expect(res.body.membership_url).toBe('/dashboard/membership');
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it.each([
    ['active'],
    ['past_due'],
    ['unpaid'],
    ['incomplete'],
    ['trialing'],
    ['canceled'],
  ])('opens the portal for subscription_status=%s (existing subscription, portal is the right tool)', async (status) => {
    await seedOrg(pool, { subscriptionStatus: status });

    const res = await request(app).post(`/api/organizations/${TEST_ORG}/billing/portal`).send({});

    expect(res.status).toBe(200);
    expect(res.body.portal_url).toBe('https://billing.stripe.com/p/session/x');
    expect(mockCreatePortalSession).toHaveBeenCalledTimes(1);
  });
});
