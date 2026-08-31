import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createInvoicePaymentSucceededEvent,
  createInvoicePaymentFailedEvent,
  createChargeRefundedEvent,
  createSubscriptionUpdatedEvent,
} from '../fixtures/stripe-webhooks.js';
import type { Pool } from 'pg';
import { OrganizationDatabase } from '../../src/db/organization-db.js';

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      workos_user_id: 'user_test_admin',
      email: 'admin@test.com',
      is_admin: true
    };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireGlobalAdmin: [
    (req: any, _res: any, next: any) => {
      req.user = { id: 'user_test_admin', email: 'admin@test.com', is_admin: true };
      next();
    },
    (_req: any, _res: any, next: any) => next(),
  ],
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

// vi.mock factories are hoisted above all top-level statements, so any vars
// referenced inside must be declared via vi.hoisted to be live at factory-evaluation time.
const mocks = vi.hoisted(() => ({
  mockConstructEvent: vi.fn().mockImplementation((body: any) => {
    return typeof body === 'string' ? JSON.parse(body) : JSON.parse(body.toString());
  }),
  // Reject to exercise the handler's description-fallback path (try/catch around products.retrieve).
  mockProductsRetrieve: vi.fn().mockRejectedValue(new Error('No Stripe product in test env')),
  mockCustomersRetrieve: vi.fn().mockResolvedValue({ deleted: true }),
  mockCustomersUpdate: vi.fn().mockResolvedValue({}),
  mockSubscriptionsList: vi.fn().mockResolvedValue({ data: [] }),
  mockSubscriptionsUpdate: vi.fn().mockResolvedValue({}),
  mockAttemptStripeReconciliation: vi.fn().mockResolvedValue({
    healed: false,
    reason: 'already_entitled',
  }),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: {
    webhooks: { constructEvent: mocks.mockConstructEvent },
    products: { retrieve: mocks.mockProductsRetrieve },
    customers: {
      retrieve: mocks.mockCustomersRetrieve,
      update: mocks.mockCustomersUpdate,
    },
    subscriptions: {
      list: mocks.mockSubscriptionsList,
      update: mocks.mockSubscriptionsUpdate,
    },
  },
  STRIPE_WEBHOOK_SECRET: 'whsec_test_fixture',
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

vi.mock('../../src/billing/lazy-reconcile.js', () => ({
  attemptStripeReconciliation: mocks.mockAttemptStripeReconciliation,
}));

describe('Revenue Tracking Integration Tests', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const TEST_ORG_ID = 'org_test_revenue';
  const TEST_CUSTOMER_ID = 'cus_test_revenue';
  const TEST_TIER_ORG_ID = 'org_test_webhook_tier_preserve';
  const TEST_TIER_CUSTOMER_ID = 'cus_test_webhook_tier_preserve';
  const TEST_TIER_SUBSCRIPTION_ID = 'sub_test_webhook_tier_preserve';

  // Helper function to send webhook with proper headers
  const sendWebhook = (event: any) => {
    return request(app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 't=mock_timestamp,v1=mock_signature')
      .send(event);
  };

  const recordExpectedCheckoutSession = async (sessionId: string) => {
    await pool.query(
      `INSERT INTO membership_checkout_attempts (
         organization_id, payload_fingerprint, idempotency_key,
         initiated_by_user_id, stripe_session_id, stripe_session_url, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours')
       ON CONFLICT (organization_id) DO UPDATE SET
         payload_fingerprint = EXCLUDED.payload_fingerprint,
         idempotency_key = EXCLUDED.idempotency_key,
         initiated_by_user_id = EXCLUDED.initiated_by_user_id,
         stripe_session_id = EXCLUDED.stripe_session_id,
         stripe_session_url = EXCLUDED.stripe_session_url,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        TEST_ORG_ID,
        `fingerprint:${sessionId}`,
        `idempotency:${sessionId}`,
        'user_test_admin',
        sessionId,
        `https://checkout.stripe.test/${sessionId}`,
      ],
    );
  };

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Create test organization
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG_ID, 'Test Revenue Org', TEST_CUSTOMER_ID]
    );
    await pool.query(
      `INSERT INTO organizations (
         workos_organization_id, name, stripe_customer_id, stripe_subscription_id, is_personal,
         subscription_status, subscription_price_lookup_key, subscription_amount,
         subscription_interval, membership_tier, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, false, 'active', 'aao_membership_builder_2500', 250000,
               'year', 'individual_academic', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         is_personal = EXCLUDED.is_personal,
         subscription_status = EXCLUDED.subscription_status,
         subscription_price_lookup_key = EXCLUDED.subscription_price_lookup_key,
         subscription_amount = EXCLUDED.subscription_amount,
         subscription_interval = EXCLUDED.subscription_interval,
         membership_tier = EXCLUDED.membership_tier`,
      [TEST_TIER_ORG_ID, 'Webhook Tier Preserve Org', TEST_TIER_CUSTOMER_ID, TEST_TIER_SUBSCRIPTION_ID]
    );

    server = new HTTPServer();
    await server.start(0); // Use port 0 for random port
    app = server.app;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM subscription_line_items WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM membership_checkout_attempts WHERE organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM subscription_line_items WHERE workos_organization_id = $1', [TEST_TIER_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_TIER_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);

    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    mocks.mockCustomersRetrieve.mockReset();
    mocks.mockCustomersRetrieve.mockResolvedValue({ deleted: true });
    mocks.mockCustomersUpdate.mockReset();
    mocks.mockCustomersUpdate.mockResolvedValue({});
    mocks.mockSubscriptionsList.mockReset();
    mocks.mockSubscriptionsList.mockResolvedValue({ data: [] });
    mocks.mockSubscriptionsUpdate.mockReset();
    mocks.mockSubscriptionsUpdate.mockResolvedValue({});
    mocks.mockAttemptStripeReconciliation.mockReset();
    mocks.mockAttemptStripeReconciliation.mockResolvedValue({
      healed: false,
      reason: 'already_entitled',
    });

    // Clear revenue data before each test
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM subscription_line_items WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query(
      `UPDATE organizations
          SET stripe_customer_id = $2
        WHERE workos_organization_id = $1`,
      [TEST_ORG_ID, TEST_CUSTOMER_ID],
    );
    await pool.query(
      `UPDATE organizations
          SET stripe_customer_id = $2,
              stripe_subscription_id = $3,
              is_personal = false,
              subscription_status = 'active',
              subscription_canceled_at = NULL,
              subscription_price_lookup_key = 'aao_membership_builder_2500',
              subscription_amount = 250000,
              subscription_interval = 'year',
              membership_tier = 'individual_academic'
        WHERE workos_organization_id = $1`,
      [TEST_TIER_ORG_ID, TEST_TIER_CUSTOMER_ID, TEST_TIER_SUBSCRIPTION_ID],
    );
  });

  describe('invoice.payment_succeeded webhook', () => {
    it('should record revenue event for successful payment', async () => {
      const event = createInvoicePaymentSucceededEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 4999, // $49.99
        productName: 'Enterprise Plan',
        interval: 'month',
      });

      const response = await sendWebhook(event);

      expect(response.status).toBe(200);

      expect(response.body).toEqual({ received: true });

      // Verify revenue event was created
      const revenueResult = await pool.query(
        'SELECT * FROM revenue_events WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      expect(revenueResult.rows).toHaveLength(1);
      const revenueEvent = revenueResult.rows[0];
      expect(revenueEvent.amount_paid).toBe(4999);
      expect(revenueEvent.revenue_type).toBe('subscription_initial');
      expect(revenueEvent.product_name).toContain('Enterprise');
      expect(revenueEvent.billing_interval).toBe('month');
    });

    it('should store subscription line items for multi-product subscriptions', async () => {
      const subscriptionId = `sub_test_multi_${Date.now()}`;
      const event = createInvoicePaymentSucceededEvent({
        customerId: TEST_CUSTOMER_ID,
        subscriptionId,
        amount: 9999,
      });

      await sendWebhook(event).expect(200);

      // Verify line items were stored
      const lineItemsResult = await pool.query(
        'SELECT * FROM subscription_line_items WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      expect(lineItemsResult.rows.length).toBeGreaterThan(0);
      const lineItem = lineItemsResult.rows[0];
      expect(lineItem.stripe_subscription_id).toBe(subscriptionId);
      expect(lineItem.amount).toBeGreaterThan(0);
    });

    it('should update organization subscription details', async () => {
      const event = createInvoicePaymentSucceededEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 2999,
        interval: 'year',
      });

      await sendWebhook(event).expect(200);

      // Verify organization was updated
      const orgResult = await pool.query(
        'SELECT * FROM organizations WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      const org = orgResult.rows[0];
      expect(org.subscription_amount).toBe(2999);
      expect(org.subscription_interval).toBe('year');
      expect(org.subscription_currency).toBe('usd');
    });

    it('should handle recurring payments (not just initial)', async () => {
      // First payment - initial
      const initialEvent = createInvoicePaymentSucceededEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 2999,
      });
      (initialEvent.data.object as any).billing_reason = 'subscription_create';

      await sendWebhook(initialEvent).expect(200);

      // Second payment - recurring
      const recurringEvent = createInvoicePaymentSucceededEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 2999,
      });
      (recurringEvent.data.object as any).billing_reason = 'subscription_cycle';

      await sendWebhook(recurringEvent).expect(200);

      // Verify both events recorded with correct types
      const revenueResult = await pool.query(
        'SELECT revenue_type FROM revenue_events WHERE workos_organization_id = $1 ORDER BY created_at',
        [TEST_ORG_ID]
      );

      expect(revenueResult.rows).toHaveLength(2);
      expect(revenueResult.rows[0].revenue_type).toBe('subscription_initial');
      expect(revenueResult.rows[1].revenue_type).toBe('subscription_recurring');
    });
  });

  describe('customer.subscription.updated webhook', () => {
    it('writes the resolved current tier when the webhook payload cannot resolve one', async () => {
      const event = createSubscriptionUpdatedEvent({
        customerId: TEST_TIER_CUSTOMER_ID,
        subscriptionId: TEST_TIER_SUBSCRIPTION_ID,
        status: 'active',
        lookupKey: null,
        unitAmount: 0,
        interval: 'year',
      });

      await sendWebhook(event).expect(200);

      const orgResult = await pool.query<{
        membership_tier: string | null;
        subscription_price_lookup_key: string | null;
      }>(
        `SELECT membership_tier, subscription_price_lookup_key
           FROM organizations WHERE workos_organization_id = $1`,
        [TEST_TIER_ORG_ID],
      );

      expect(orgResult.rows[0].membership_tier).toBe('company_standard');
      expect(orgResult.rows[0].subscription_price_lookup_key).toBeNull();
    });
  });

  describe('checkout.session.completed webhook', () => {
    it('reconciles an already-linked buyer-agent checkout that has no intake-attempt row', async () => {
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: { workos_organization_id: TEST_ORG_ID },
      });

      const event = {
        id: 'evt_checkout_completed_buyer_agent',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_buyer_agent',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      await sendWebhook(event).expect(200, { received: true });

      expect(mocks.mockAttemptStripeReconciliation).toHaveBeenCalledWith(
        TEST_ORG_ID,
        expect.objectContaining({ pool }),
      );
    });

    it('reconciles billing state for an already-linked, metadata-verified customer', async () => {
      await recordExpectedCheckoutSession('cs_test_reconcile');
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: { workos_organization_id: TEST_ORG_ID },
      });
      mocks.mockAttemptStripeReconciliation.mockResolvedValue({
        healed: true,
        reason: 'healed_from_stripe',
        subscriptionStatus: 'active',
      });

      const event = {
        id: 'evt_checkout_completed_reconcile',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_reconcile',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      await sendWebhook(event).expect(200, { received: true });

      expect(mocks.mockAttemptStripeReconciliation).toHaveBeenCalledWith(
        TEST_ORG_ID,
        expect.objectContaining({
          pool,
          stripe: expect.any(Object),
          logger: expect.any(Object),
        }),
      );
    });

    it('links a new checkout customer before reconciling billing state', async () => {
      await recordExpectedCheckoutSession('cs_test_new_customer');
      await pool.query(
        `UPDATE organizations
            SET stripe_customer_id = NULL
          WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      const event = {
        id: 'evt_checkout_completed_new_customer',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_new_customer',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      await sendWebhook(event).expect(200, { received: true });

      expect(mocks.mockCustomersUpdate).toHaveBeenCalledWith(TEST_CUSTOMER_ID, {
        metadata: { workos_organization_id: TEST_ORG_ID },
      });
      const linked = await pool.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id
           FROM organizations
          WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      expect(linked.rows[0]?.stripe_customer_id).toBe(TEST_CUSTOMER_ID);
      expect(mocks.mockAttemptStripeReconciliation).toHaveBeenCalledWith(
        TEST_ORG_ID,
        expect.objectContaining({ pool }),
      );
    });

    it('does not reconcile when Stripe customer metadata points to another org', async () => {
      await recordExpectedCheckoutSession('cs_test_conflict');
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: { workos_organization_id: 'org_different_customer_owner' },
      });

      const event = {
        id: 'evt_checkout_completed_conflict',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_conflict',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      await sendWebhook(event).expect(200, { received: true });

      expect(mocks.mockAttemptStripeReconciliation).not.toHaveBeenCalled();
    });

    it('does not reconcile when the org is linked to a different Stripe customer', async () => {
      const checkoutCustomerId = 'cus_test_different_checkout_customer';
      await recordExpectedCheckoutSession('cs_test_local_link_conflict');
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: checkoutCustomerId,
        deleted: false,
        metadata: { workos_organization_id: TEST_ORG_ID },
      });

      const event = {
        id: 'evt_checkout_completed_local_link_conflict',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_local_link_conflict',
            mode: 'subscription',
            customer: checkoutCustomerId,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      await sendWebhook(event).expect(200, { received: true });

      expect(mocks.mockAttemptStripeReconciliation).not.toHaveBeenCalled();
    });

    it('returns 500 so Stripe retries a transient reconciliation failure', async () => {
      await recordExpectedCheckoutSession('cs_test_transient_failure');
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: { workos_organization_id: TEST_ORG_ID },
      });
      mocks.mockAttemptStripeReconciliation.mockResolvedValue({
        healed: false,
        reason: 'stripe_error',
      });

      const event = {
        id: 'evt_checkout_completed_transient_failure',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_transient_failure',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      const response = await sendWebhook(event).expect(500);

      expect(response.body).toEqual({ error: 'Webhook processing failed' });
    });

    it('returns 500 so Stripe retries a transient local-link database failure', async () => {
      await recordExpectedCheckoutSession('cs_test_link_db_failure');
      await pool.query(
        `UPDATE organizations
            SET stripe_customer_id = NULL
          WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: { workos_organization_id: TEST_ORG_ID },
      });
      const setCustomerSpy = vi.spyOn(
        OrganizationDatabase.prototype,
        'setStripeCustomerId',
      ).mockRejectedValueOnce(new Error('database unavailable'));

      const event = {
        id: 'evt_checkout_completed_link_db_failure',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_link_db_failure',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      try {
        const response = await sendWebhook(event).expect(500);
        expect(response.body).toEqual({ error: 'Webhook processing failed' });
        expect(mocks.mockAttemptStripeReconciliation).not.toHaveBeenCalled();
      } finally {
        setCustomerSpy.mockRestore();
      }
    });

    it('ignores a replay after its checkout generation was invalidated by an admin unlink', async () => {
      await pool.query(
        `UPDATE organizations SET
            stripe_customer_id = NULL,
            stripe_subscription_id = NULL,
            subscription_status = NULL,
            subscription_amount = NULL,
            subscription_price_lookup_key = NULL
          WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      const event = {
        id: 'evt_checkout_completed_invalidated_replay',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_invalidated_replay',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      };

      await sendWebhook(event).expect(200, { received: true });

      expect(mocks.mockCustomersRetrieve).not.toHaveBeenCalled();
      expect(mocks.mockCustomersUpdate).not.toHaveBeenCalled();
      expect(mocks.mockAttemptStripeReconciliation).not.toHaveBeenCalled();
      const org = await pool.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM organizations WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      expect(org.rows[0]?.stripe_customer_id).toBeNull();
    });

    it('serializes admin unlink ahead of a concurrent checkout replay', async () => {
      await recordExpectedCheckoutSession('cs_test_concurrent_unlink');
      let releaseMetadataClear!: () => void;
      let signalMetadataClear!: () => void;
      const metadataClearStarted = new Promise<void>((resolve) => {
        signalMetadataClear = resolve;
      });
      const holdMetadataClear = new Promise<void>((resolve) => {
        releaseMetadataClear = resolve;
      });
      mocks.mockCustomersUpdate.mockImplementationOnce(async () => {
        signalMetadataClear();
        await holdMetadataClear;
        return {};
      });
      mocks.mockCustomersRetrieve.mockResolvedValue({
        id: TEST_CUSTOMER_ID,
        deleted: false,
        metadata: { workos_organization_id: TEST_ORG_ID },
      });

      const unlinkPromise = request(app)
        .post(`/api/admin/stripe-customers/${TEST_CUSTOMER_ID}/unlink`)
        .then((response) => response);
      await metadataClearStarted;

      const webhookPromise = sendWebhook({
        id: 'evt_checkout_completed_concurrent_unlink',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_concurrent_unlink',
            mode: 'subscription',
            customer: TEST_CUSTOMER_ID,
            metadata: { workos_organization_id: TEST_ORG_ID },
          },
        },
      }).then((response) => response);

      releaseMetadataClear();
      const unlinkResponse = await unlinkPromise;
      const webhookResponse = await webhookPromise;

      expect(unlinkResponse.status).toBe(200);
      expect(webhookResponse.status).toBe(200);
      expect(mocks.mockCustomersUpdate).toHaveBeenCalledTimes(1);
      expect(mocks.mockCustomersRetrieve).not.toHaveBeenCalled();
      expect(mocks.mockAttemptStripeReconciliation).not.toHaveBeenCalled();
      const org = await pool.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM organizations WHERE workos_organization_id = $1`,
        [TEST_ORG_ID],
      );
      expect(org.rows[0]?.stripe_customer_id).toBeNull();
    });
  });

  describe('invoice.payment_failed webhook', () => {
    it('should record failed payment attempt', async () => {
      const event = createInvoicePaymentFailedEvent({
        customerId: TEST_CUSTOMER_ID,
        attemptCount: 2,
      });

      await sendWebhook(event).expect(200);

      // Verify failed payment was recorded
      const revenueResult = await pool.query(
        'SELECT * FROM revenue_events WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      expect(revenueResult.rows).toHaveLength(1);
      const revenueEvent = revenueResult.rows[0];
      expect(revenueEvent.amount_paid).toBe(0);
      expect(revenueEvent.revenue_type).toBe('payment_failed');
      expect(revenueEvent.metadata).toHaveProperty('attempt_count', 2);
    });

    it('should not create subscription line items for failed payments', async () => {
      const event = createInvoicePaymentFailedEvent({
        customerId: TEST_CUSTOMER_ID,
      });

      await sendWebhook(event).expect(200);

      // Verify no line items created
      const lineItemsResult = await pool.query(
        'SELECT * FROM subscription_line_items WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      expect(lineItemsResult.rows).toHaveLength(0);
    });
  });

  describe('charge.refunded webhook', () => {
    it('should record full refund as negative revenue', async () => {
      const event = createChargeRefundedEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 2999,
        refundedAmount: 2999,
        refundReason: 'requested_by_customer',
      });

      await sendWebhook(event).expect(200);

      // Verify refund was recorded as negative revenue
      const revenueResult = await pool.query(
        'SELECT * FROM revenue_events WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      expect(revenueResult.rows).toHaveLength(1);
      const revenueEvent = revenueResult.rows[0];
      expect(revenueEvent.amount_paid).toBe(-2999); // Negative!
      expect(revenueEvent.revenue_type).toBe('refund');
      expect(revenueEvent.metadata).toHaveProperty('refund_reason', 'requested_by_customer');
    });

    it('should handle partial refunds', async () => {
      const event = createChargeRefundedEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 2999,
        refundedAmount: 1500, // Partial refund
      });

      await sendWebhook(event).expect(200);

      const revenueResult = await pool.query(
        'SELECT * FROM revenue_events WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      expect(revenueResult.rows).toHaveLength(1);
      expect(revenueResult.rows[0].amount_paid).toBe(-1500);
    });

    it('should not automatically cancel subscription on refund', async () => {
      // First, create a successful payment
      const paymentEvent = createInvoicePaymentSucceededEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 2999,
      });

      await sendWebhook(paymentEvent).expect(200);

      // Then refund it
      const refundEvent = createChargeRefundedEvent({
        customerId: TEST_CUSTOMER_ID,
        amount: 2999,
        refundedAmount: 2999,
      });

      await sendWebhook(refundEvent).expect(200);

      // Verify subscription still exists
      const orgResult = await pool.query(
        'SELECT subscription_canceled_at FROM organizations WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      expect(orgResult.rows[0].subscription_canceled_at).toBeNull();
    });
  });

  // Admin stats endpoint requires setupAuthRoutes() which doesn't run in tests without WorkOS
  // TODO: Move admin stats route to setupRoutes() to enable these tests
  describe('Admin stats endpoint', () => {
    it('should calculate total revenue correctly', async () => {
      // Create multiple payment events
      await pool.query(
        `INSERT INTO revenue_events (
          workos_organization_id, stripe_invoice_id, amount_paid, currency,
          revenue_type, paid_at
        ) VALUES
          ($1, 'inv_1', 2999, 'usd', 'subscription_initial', NOW()),
          ($1, 'inv_2', 2999, 'usd', 'subscription_recurring', NOW()),
          ($1, 'inv_3', 5000, 'usd', 'one_time', NOW())`,
        [TEST_ORG_ID]
      );

      const response = await request(app)
        .get('/api/admin/stats')
        .expect(200);

      // formatCurrency rounds to whole dollars for the admin dashboard.
      // 2999 + 2999 + 5000 = 10998 cents → $110 (rounded from $109.98).
      expect(response.body.total_revenue).toBe('$110');
      expect(response.body.recurring_revenue).toBe('$30'); // $29.99 → $30
      expect(response.body.one_time_revenue).toBe('$80'); // $79.99 → $80
    });

    it('should calculate MRR correctly from active subscriptions', async () => {
      // MRR is computed from revenue_events with future period_end and a non-null
      // subscription id, not from columns on the organizations table.
      await pool.query(
        `INSERT INTO revenue_events (
          workos_organization_id, stripe_invoice_id, stripe_subscription_id,
          amount_paid, currency, revenue_type, billing_interval,
          period_end, paid_at
        ) VALUES (
          $1, 'inv_mrr', 'sub_mrr_active',
          2999, 'usd', 'subscription_initial', 'month',
          NOW() + INTERVAL '30 days', NOW()
        )`,
        [TEST_ORG_ID]
      );

      const response = await request(app)
        .get('/api/admin/stats')
        .expect(200);

      // formatCurrency rounds to whole dollars: 2999¢ → $30, ARR = MRR*12 → $360.
      expect(response.body.mrr).toBe('$30');
      expect(response.body.arr).toBe('$360');
    });

    it('should handle refunds in total revenue calculation', async () => {
      // Create payment and refund
      await pool.query(
        `INSERT INTO revenue_events (
          workos_organization_id, stripe_invoice_id, amount_paid, currency,
          revenue_type, paid_at
        ) VALUES
          ($1, 'inv_1', 2999, 'usd', 'subscription_initial', NOW()),
          ($1, 'ref_1', -2999, 'usd', 'refund', NOW())`,
        [TEST_ORG_ID]
      );

      const response = await request(app)
        .get('/api/admin/stats')
        .expect(200);

      // formatCurrency rounds to whole dollars; net = 0¢ → $0, refund = 2999¢ → $30.
      expect(response.body.total_revenue).toBe('$0');
      expect(response.body.total_refunds).toBe('$30');
    });

    it('should show product breakdown', async () => {
      // Create events for different products
      await pool.query(
        `INSERT INTO revenue_events (
          workos_organization_id, stripe_invoice_id, amount_paid, currency,
          revenue_type, product_name, paid_at
        ) VALUES
          ($1, 'inv_1', 2999, 'usd', 'subscription_initial', 'Basic Plan', NOW()),
          ($1, 'inv_2', 4999, 'usd', 'subscription_initial', 'Pro Plan', NOW()),
          ($1, 'inv_3', 2999, 'usd', 'subscription_recurring', 'Basic Plan', NOW())`,
        [TEST_ORG_ID]
      );

      const response = await request(app)
        .get('/api/admin/stats')
        .expect(200);

      expect(response.body.product_breakdown).toHaveLength(2);
      const basicPlan = response.body.product_breakdown.find((p: any) => p.product_name === 'Basic Plan');
      expect(basicPlan.count).toBe('2');
      // formatCurrency rounds: 5998¢ → $60.
      expect(basicPlan.revenue).toBe('$60');
    });
  });
});
