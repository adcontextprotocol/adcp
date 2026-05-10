/**
 * Route-level test for GET /api/organizations/:orgId/billing — confirms the
 * auto-heal path when an org's stripe_customer_id points at a non-existent
 * Stripe customer. Without this, every billing page load 500s and pages the
 * error channel.
 *
 * Reproduces the scenario from the `cus_TuAG0b4JSg5zi0` system error: stored
 * customer ID exists in DB but Stripe returns resource_missing on session
 * creation. Expected: route catches the error, unlinks the stale ID, calls
 * getOrCreateStripeCustomer to mint a fresh one, retries createCustomerSession
 * once, and returns the new secret. The org row's stripe_customer_id is
 * updated in place.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const {
  TEST_USER_ID,
  TEST_ORG,
  STALE_CUSTOMER_ID,
  FRESH_CUSTOMER_ID,
  RECOVERY_SECRET,
  mockListMemberships,
  mockCreateStripeCustomer,
  mockCreateCustomerSession,
  mockGetPendingInvoices,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    TEST_USER_ID: 'user_stale_test',
    TEST_ORG: 'org_stale_customer_test',
    STALE_CUSTOMER_ID: 'cus_stale_does_not_exist',
    FRESH_CUSTOMER_ID: 'cus_fresh_after_unlink',
    RECOVERY_SECRET: 'cs_test_recovery_secret',
    mockListMemberships: vi.fn().mockResolvedValue({
      data: [{ id: 'om_test', role: { slug: 'owner' }, status: 'active' }],
    }),
    mockCreateStripeCustomer: vi.fn(),
    mockCreateCustomerSession: vi.fn(),
    mockGetPendingInvoices: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships: mockListMemberships,
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: 'tester@stale.test' }),
    };
    organizations = {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG, name: 'Stale Customer Test Org' }),
    };
  },
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: mockListMemberships,
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: 'tester@stale.test' }),
    },
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: TEST_ORG, name: 'Stale Customer Test Org' }),
    },
  },
  getWorkos: () => ({
    userManagement: {
      listOrganizationMemberships: mockListMemberships,
      getUser: vi.fn().mockResolvedValue({ id: TEST_USER_ID, email: 'tester@stale.test' }),
    },
  }),
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'tester@stale.test',
      firstName: 'Stale',
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

vi.mock('../../src/billing/stripe-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/billing/stripe-client.js')>();
  return {
    ...actual,
    stripe: {} as object,
    createStripeCustomer: mockCreateStripeCustomer,
    createCustomerSession: mockCreateCustomerSession,
    getPendingInvoices: mockGetPendingInvoices,
    getStripeSubscriptionInfo: vi.fn().mockResolvedValue(null),
    listCustomersWithOrgIds: vi.fn().mockResolvedValue([]),
  };
});

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
}

async function seedOrgWithStaleCustomer(pool: Pool, customerId: string) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, stripe_customer_id, created_at, updated_at)
     VALUES ($1, $2, false, $3, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
    [TEST_ORG, 'Stale Customer Test Org', customerId],
  );
}

describe('GET /api/organizations/:orgId/billing — stale stripe_customer_id auto-heal', () => {
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
    mockCreateStripeCustomer.mockReset();
    mockCreateCustomerSession.mockReset();
    mockGetPendingInvoices.mockReset();
    mockGetPendingInvoices.mockResolvedValue([]);
  });

  it('unlinks stale customer, mints a fresh one, retries createCustomerSession, and returns the new secret', async () => {
    await seedOrgWithStaleCustomer(pool, STALE_CUSTOMER_ID);

    // First call (with stale id) throws Stripe-shape resource_missing.
    // Second call (with fresh id) returns a session secret.
    mockCreateCustomerSession
      .mockRejectedValueOnce(Object.assign(new Error('No such customer'), {
        code: 'resource_missing',
        statusCode: 404,
      }))
      .mockResolvedValueOnce(RECOVERY_SECRET);
    mockCreateStripeCustomer.mockResolvedValueOnce(FRESH_CUSTOMER_ID);

    const res = await request(app).get(`/api/organizations/${TEST_ORG}/billing`);

    expect(res.status).toBe(200);
    expect(res.body.stripe_customer_id).toBe(FRESH_CUSTOMER_ID);
    expect(res.body.customer_session_secret).toBe(RECOVERY_SECRET);

    // createCustomerSession was called twice: once with stale, once with fresh.
    expect(mockCreateCustomerSession).toHaveBeenCalledTimes(2);
    expect(mockCreateCustomerSession).toHaveBeenNthCalledWith(1, STALE_CUSTOMER_ID);
    expect(mockCreateCustomerSession).toHaveBeenNthCalledWith(2, FRESH_CUSTOMER_ID);

    // Stale ID was unlinked and replaced in the DB row, not just in memory.
    const persisted = await pool.query<{ stripe_customer_id: string }>(
      'SELECT stripe_customer_id FROM organizations WHERE workos_organization_id = $1',
      [TEST_ORG],
    );
    expect(persisted.rows[0].stripe_customer_id).toBe(FRESH_CUSTOMER_ID);
  });

  it('happy path: existing valid customer ID is returned without the recovery dance', async () => {
    await seedOrgWithStaleCustomer(pool, FRESH_CUSTOMER_ID);

    mockCreateCustomerSession.mockResolvedValueOnce(RECOVERY_SECRET);

    const res = await request(app).get(`/api/organizations/${TEST_ORG}/billing`);

    expect(res.status).toBe(200);
    expect(res.body.stripe_customer_id).toBe(FRESH_CUSTOMER_ID);
    expect(res.body.customer_session_secret).toBe(RECOVERY_SECRET);

    expect(mockCreateCustomerSession).toHaveBeenCalledTimes(1);
    expect(mockCreateStripeCustomer).not.toHaveBeenCalled();
  });
});
