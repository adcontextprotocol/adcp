import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createInvoicePaymentSucceededEvent,
  createInvoicePaymentFailedEvent,
  createChargeRefundedEvent,
} from '../fixtures/stripe-webhooks.js';
import type { Pool } from 'pg';

// No need to mock Stripe - we'll use real test mode!
// We only need to mock the webhook signature verification

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = {
      workos_user_id: 'user_test_admin',
      email: 'admin@test.com',
      is_admin: true
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => next(),
}));

describe('Revenue Tracking Integration Tests', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const TEST_ORG_ID = 'org_test_revenue';
  const TEST_CUSTOMER_ID = 'cus_test_revenue';

  // Helper function to send webhook with proper headers
  const sendWebhook = (event: any) => {
    return request(app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 't=mock_timestamp,v1=mock_signature')
      .send(event);
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

    // Initialize HTTP server with real Stripe test mode
    server = new HTTPServer();
    await server.start(0); // Use port 0 for random port
    app = server.app;

    // Override Stripe webhook signature verification for tests
    // This allows us to send test events without valid Stripe signatures
    const stripeClient = await import('../../src/billing/stripe-client.js');
    console.log('[TEST] Stripe client initialized:', !!stripeClient.stripe);
    console.log('[TEST] STRIPE_WEBHOOK_SECRET set:', !!stripeClient.STRIPE_WEBHOOK_SECRET);

    // Webhook route is now registered!

    if (stripeClient.stripe) {
      const originalConstructEvent = stripeClient.stripe.webhooks.constructEvent.bind(stripeClient.stripe.webhooks);
      stripeClient.stripe.webhooks.constructEvent = ((body: any, signature: string, secret: string) => {
        // In tests, skip signature verification and just parse the event
        // body is a Buffer from express.raw(), need to convert to string first
        const bodyString = Buffer.isBuffer(body) ? body.toString('utf8') :
                          typeof body === 'string' ? body :
                          JSON.stringify(body);
        return JSON.parse(bodyString);
      }) as any;
    }
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM subscription_line_items WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);

    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clear revenue data before each test
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM subscription_line_items WHERE workos_organization_id = $1', [TEST_ORG_ID]);
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

      if (response.status !== 200) {
        console.log('Webhook response status:', response.status);
        console.log('Webhook response body:', response.body);
      }

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

      expect(response.body.total_revenue).toBe('$109.98'); // 2999 + 2999 + 5000 = 10998 cents = $109.98
      expect(response.body.recurring_revenue).toBe('$29.99');
      expect(response.body.one_time_revenue).toBe('$79.99'); // 2999 + 5000 = 7999 cents = $79.99
    });

    it('should calculate MRR correctly from active subscriptions', async () => {
      // Set up organization with monthly subscription
      await pool.query(
        `UPDATE organizations
         SET subscription_amount = 2999,
             subscription_interval = 'month',
             subscription_current_period_end = NOW() + INTERVAL '30 days',
             subscription_canceled_at = NULL
         WHERE workos_organization_id = $1`,
        [TEST_ORG_ID]
      );

      const response = await request(app)
        .get('/api/admin/stats')
        .expect(200);

      expect(response.body.mrr).toBe('$29.99');
      expect(response.body.arr).toBe('$359.88'); // MRR * 12
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

      expect(response.body.total_revenue).toBe('$0.00');
      expect(response.body.total_refunds).toBe('$29.99');
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
      expect(basicPlan.revenue).toBe('$59.98');
    });
  });
});
