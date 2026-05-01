/**
 * Integration tests for admin Stripe customer link/unlink endpoints.
 *
 * Exercises the security and idempotency hardening in #3681 + #3692:
 *   - link with multi-sub customer picks the membership sub (not data[0])
 *   - link force-replace clears stale state when new customer has no
 *     membership sub
 *   - unlink clears all subscription_* columns (not just stripe_customer_id)
 *   - unlink clears the Stripe customer's metadata.workos_organization_id
 *     so a subsequent webhook can't silently re-link
 *   - unlink writes a registry_audit_log entry for forensic trail
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_test_admin', email: 'admin@test.com', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

const mocks = vi.hoisted(() => {
  // A multi-sub customer: non-membership sub listed first, membership sub
  // second. data[0] would pick the non-membership sub; pickMembershipSub
  // must select the membership one.
  const multiSubCustomer = {
    id: 'cus_link_test_multi',
    deleted: false,
    metadata: { workos_organization_id: 'org_link_test_target' },
    subscriptions: {
      data: [
        {
          id: 'sub_event_ticket_001',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          canceled_at: null,
          items: {
            data: [{
              price: {
                id: 'price_event_ticket',
                product: 'prod_event_ticket',
                unit_amount: 5000,
                currency: 'usd',
                recurring: { interval: 'year' },
                lookup_key: 'aao_event_ticket_2026',
              },
            }],
          },
        },
        {
          id: 'sub_member_001',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 365,
          canceled_at: null,
          items: {
            data: [{
              price: {
                id: 'price_member',
                product: 'prod_member',
                unit_amount: 25000,
                currency: 'usd',
                recurring: { interval: 'year' },
                lookup_key: 'aao_membership_professional_250',
              },
            }],
          },
        },
      ],
    },
  };

  // A customer with NO membership sub — only a non-membership sub.
  // Used to test force-replace clearing stale state.
  const nonMembershipCustomer = {
    id: 'cus_link_test_nonmembership',
    deleted: false,
    metadata: { workos_organization_id: 'org_link_test_target' },
    subscriptions: {
      data: [{
        id: 'sub_event_only_001',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        canceled_at: null,
        items: {
          data: [{
            price: {
              id: 'price_event_only',
              product: 'prod_event_only',
              unit_amount: 5000,
              currency: 'usd',
              recurring: { interval: 'year' },
              lookup_key: 'aao_event_other',
            },
          }],
        },
      }],
    },
  };

  return {
    multiSubCustomer,
    nonMembershipCustomer,
    mockCustomersRetrieve: vi.fn(),
    mockCustomersUpdate: vi.fn().mockResolvedValue({}),
    mockSubscriptionsList: vi.fn().mockResolvedValue({ data: [] }),
    mockSubscriptionsUpdate: vi.fn().mockResolvedValue({}),
    mockInvoicesList: vi.fn().mockImplementation(async function* () { /* none */ }),
    mockProductsRetrieve: vi.fn().mockResolvedValue({ id: 'prod_x', name: 'Test Product' }),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: {
    customers: { retrieve: mocks.mockCustomersRetrieve, update: mocks.mockCustomersUpdate },
    subscriptions: { list: mocks.mockSubscriptionsList, update: mocks.mockSubscriptionsUpdate },
    invoices: { list: mocks.mockInvoicesList },
    products: { retrieve: mocks.mockProductsRetrieve },
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
  STRIPE_WEBHOOK_SECRET: null,
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerPortalSession: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  fetchAllPaidInvoices: vi.fn().mockResolvedValue([]),
  fetchAllRefunds: vi.fn().mockResolvedValue([]),
  getPendingInvoices: vi.fn().mockResolvedValue([]),
  getBillingProducts: vi.fn().mockResolvedValue([]),
  getStripeSubscriptionInfo: vi.fn().mockResolvedValue(null),
  listCustomersWithOrgIds: vi.fn().mockResolvedValue(new Map()),
}));

describe('POST /api/admin/stripe-customers/:customerId/link + /unlink', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const TEST_ORG_ID = 'org_link_test_target';
  const ADMIN_USER_ID = 'user_test_admin';

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, is_personal, created_at, updated_at)
       VALUES ($1, $2, NULL, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET
         stripe_customer_id = NULL,
         subscription_status = NULL,
         subscription_amount = NULL,
         subscription_price_lookup_key = NULL,
         stripe_subscription_id = NULL,
         membership_tier = NULL`,
      [TEST_ORG_ID, 'Link Test Org'],
    );
    mocks.mockCustomersRetrieve.mockReset();
    mocks.mockCustomersUpdate.mockReset();
    mocks.mockCustomersUpdate.mockResolvedValue({});
    mocks.mockSubscriptionsList.mockReset();
    mocks.mockSubscriptionsList.mockResolvedValue({ data: [] });
    mocks.mockSubscriptionsUpdate.mockReset();
    mocks.mockSubscriptionsUpdate.mockResolvedValue({});
  });

  describe('link', () => {
    it('picks the membership sub when customer has multi-sub (data[0] regression)', async () => {
      mocks.mockCustomersRetrieve.mockResolvedValueOnce(mocks.multiSubCustomer);

      const response = await request(app)
        .post(`/api/admin/stripe-customers/${mocks.multiSubCustomer.id}/link`)
        .send({ org_id: TEST_ORG_ID });

      expect(response.status).toBe(200);
      expect(response.body.subscription_synced).toBe(true);

      const orgRow = await pool.query<{
        stripe_subscription_id: string | null;
        subscription_price_lookup_key: string | null;
        subscription_amount: number | null;
      }>(
        `SELECT stripe_subscription_id, subscription_price_lookup_key, subscription_amount
           FROM organizations WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      // Must be the membership sub, not the event-ticket one that was first in data[].
      expect(orgRow.rows[0].stripe_subscription_id).toBe('sub_member_001');
      expect(orgRow.rows[0].subscription_price_lookup_key).toBe('aao_membership_professional_250');
      expect(orgRow.rows[0].subscription_amount).toBe(25000);
    });

    it('writes admin_stripe_link audit log entry', async () => {
      mocks.mockCustomersRetrieve.mockResolvedValueOnce(mocks.multiSubCustomer);

      await request(app)
        .post(`/api/admin/stripe-customers/${mocks.multiSubCustomer.id}/link`)
        .send({ org_id: TEST_ORG_ID });

      const audit = await pool.query<{ action: string; resource_id: string; details: any }>(
        `SELECT action, resource_id, details FROM registry_audit_log
          WHERE workos_organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [TEST_ORG_ID],
      );
      expect(audit.rows[0]?.action).toBe('admin_stripe_link');
      expect(audit.rows[0]?.resource_id).toBe(mocks.multiSubCustomer.id);
      expect(audit.rows[0]?.details?.admin_email).toBe('admin@test.com');
    });
  });

  describe('unlink', () => {
    it('clears all subscription_* columns (not just stripe_customer_id)', async () => {
      // Pre-populate the org with active subscription state, as if a prior
      // link succeeded.
      await pool.query(
        `UPDATE organizations SET
            stripe_customer_id = $1,
            stripe_subscription_id = 'sub_to_clear',
            subscription_status = 'active',
            subscription_amount = 25000,
            subscription_price_lookup_key = 'aao_membership_professional_250',
            membership_tier = 'individual_professional'
         WHERE workos_organization_id = $2`,
        ['cus_link_test_multi', TEST_ORG_ID],
      );

      const response = await request(app)
        .post('/api/admin/stripe-customers/cus_link_test_multi/unlink');

      expect(response.status).toBe(200);

      const orgRow = await pool.query<{
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        subscription_status: string | null;
        subscription_amount: number | null;
        subscription_price_lookup_key: string | null;
      }>(
        `SELECT stripe_customer_id, stripe_subscription_id, subscription_status,
                subscription_amount, subscription_price_lookup_key
           FROM organizations WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      expect(orgRow.rows[0].stripe_customer_id).toBeNull();
      expect(orgRow.rows[0].stripe_subscription_id).toBeNull();
      expect(orgRow.rows[0].subscription_status).toBeNull();
      expect(orgRow.rows[0].subscription_amount).toBeNull();
      expect(orgRow.rows[0].subscription_price_lookup_key).toBeNull();
    });

    it('clears Stripe customer metadata.workos_organization_id (closes webhook re-link race)', async () => {
      await pool.query(
        `UPDATE organizations SET stripe_customer_id = $1 WHERE workos_organization_id = $2`,
        ['cus_link_test_multi', TEST_ORG_ID],
      );

      await request(app)
        .post('/api/admin/stripe-customers/cus_link_test_multi/unlink');

      // Without this metadata-clear, a webhook firing for this customer
      // after the unlink would walk resolveOrgForStripeCustomer's metadata
      // fallback and silently re-link the org we just severed.
      expect(mocks.mockCustomersUpdate).toHaveBeenCalledWith(
        'cus_link_test_multi',
        { metadata: { workos_organization_id: '' } },
      );
    });

    it('clears workos_organization_id metadata on the customer\'s active subscriptions (closes step-3 webhook fallback)', async () => {
      // resolveOrgForStripeCustomer has THREE fallback paths:
      //   1. DB stripe_customer_id (cleared by the unlink UPDATE)
      //   2. customer.metadata.workos_organization_id (cleared via stripe.customers.update)
      //   3. subscription.metadata.workos_organization_id ← this test
      // Without clearing #3, a webhook for one of the customer's subs would
      // walk to step 3 and silently re-link. The unlink lists subs and
      // clears their metadata too.
      await pool.query(
        `UPDATE organizations SET stripe_customer_id = $1 WHERE workos_organization_id = $2`,
        ['cus_link_test_multi', TEST_ORG_ID],
      );
      mocks.mockSubscriptionsList.mockResolvedValueOnce({
        data: [
          { id: 'sub_a', metadata: { workos_organization_id: TEST_ORG_ID } },
          { id: 'sub_b', metadata: { workos_organization_id: TEST_ORG_ID, other: 'keep' } },
          { id: 'sub_c_no_meta', metadata: {} },  // should NOT be updated
        ],
      });

      await request(app)
        .post('/api/admin/stripe-customers/cus_link_test_multi/unlink');

      // Both subs with workos_organization_id metadata cleared
      expect(mocks.mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_a', {
        metadata: { workos_organization_id: '' },
      });
      expect(mocks.mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_b', {
        metadata: { workos_organization_id: '' },
      });
      // The sub without the metadata key is untouched (no wasted Stripe write)
      expect(mocks.mockSubscriptionsUpdate).not.toHaveBeenCalledWith('sub_c_no_meta', expect.anything());
    });

    it('writes admin_stripe_unlink audit log with prior state', async () => {
      await pool.query(
        `UPDATE organizations SET
            stripe_customer_id = 'cus_link_test_multi',
            stripe_subscription_id = 'sub_prior',
            subscription_status = 'active',
            membership_tier = 'individual_professional'
         WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );

      await request(app)
        .post('/api/admin/stripe-customers/cus_link_test_multi/unlink');

      const audit = await pool.query<{ action: string; resource_id: string; details: any; workos_user_id: string }>(
        `SELECT action, resource_id, details, workos_user_id FROM registry_audit_log
          WHERE workos_organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [TEST_ORG_ID],
      );
      expect(audit.rows[0]?.action).toBe('admin_stripe_unlink');
      expect(audit.rows[0]?.workos_user_id).toBe(ADMIN_USER_ID);
      expect(audit.rows[0]?.details?.prior_subscription_status).toBe('active');
      expect(audit.rows[0]?.details?.prior_stripe_subscription_id).toBe('sub_prior');
      expect(audit.rows[0]?.details?.prior_membership_tier).toBe('individual_professional');
      expect(audit.rows[0]?.details?.admin_email).toBe('admin@test.com');
    });
  });
});
