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

// vi.mock factories are hoisted above all top-level statements, so any vars
// referenced inside have to be declared in vi.hoisted (which is also hoisted)
// to be live at factory-evaluation time. Bare `const x = ...` at top-level
// still hits "Cannot access 'x' before initialization".
const mocks = vi.hoisted(() => {
  const FAKE_INVOICE = {
    id: 'in_backfill_test_001',
    amount_paid: 250000,
    currency: 'usd',
    billing_reason: 'subscription_create',
    subscription: 'sub_backfill_test_001',
    payment_intent: 'pi_backfill_test_001',
    charge: { id: 'ch_backfill_test_001' },
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) - 86400 },
    created: Math.floor(Date.now() / 1000) - 86400,
    period_start: Math.floor(Date.now() / 1000) - 86400,
    period_end: Math.floor(Date.now() / 1000) + 86400 * 365,
    description: null,
    lines: {
      data: [{
        id: 'il_backfill_test_001',
        price: {
          id: 'price_backfill_test_001',
          recurring: { interval: 'year' },
          product: 'prod_backfill_test_001',
        },
        description: 'AgenticAdvertising.org Membership',
      }],
    },
  };

  async function* fakeInvoiceIterator(items: unknown[]) {
    for (const item of items) yield item;
  }

  // Shared sub fixture used by both customers.retrieve (legacy callsites)
  // and subscriptions.list (post-#3850 /sync uses subscriptions.list).
  const FAKE_SUB = {
    id: 'sub_backfill_test_001',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 365,
    canceled_at: null,
    items: {
      data: [{
        price: {
          unit_amount: 250000,
          currency: 'usd',
          recurring: { interval: 'year' },
          // /sync filters to membership subs by lookup_key prefix
          // (`aao_membership_*` / `aao_invoice_*`) — fast path. Founding-
          // era subs lack the lookup_key and fall through to a product-
          // metadata fetch via stripe.products.retrieve.
          lookup_key: 'aao_membership_professional_250',
          product: 'prod_backfill_test_001',
        },
      }],
    },
  };

  return {
    FAKE_INVOICE,
    FAKE_SUB,
    mockInvoicesList: vi.fn().mockImplementation(() => fakeInvoiceIterator([FAKE_INVOICE])),
    mockCustomersRetrieve: vi.fn().mockResolvedValue({
      id: 'cus_test_backfill',
      deleted: false,
      subscriptions: { data: [FAKE_SUB] },
    }),
    // /sync fetches subs separately. No deep expand — products are
    // fetched per-sub via stripe.products.retrieve when the lookup_key
    // path doesn't match (founding-era fallback).
    mockSubscriptionsList: vi.fn().mockResolvedValue({
      data: [FAKE_SUB],
      has_more: false,
      object: 'list',
    }),
    mockProductsRetrieve: vi.fn().mockResolvedValue({
      id: 'prod_backfill_test_001',
      name: 'Pinnacle Media Annual Plan',
      metadata: { category: 'membership' },
    }),
  };
});

const { FAKE_INVOICE, mockInvoicesList, mockCustomersRetrieve, mockSubscriptionsList, mockProductsRetrieve } = mocks;

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: {
    customers: { retrieve: mocks.mockCustomersRetrieve },
    invoices: { list: mocks.mockInvoicesList },
    subscriptions: { list: mocks.mockSubscriptionsList },
    products: { retrieve: mocks.mockProductsRetrieve },
    webhooks: {
      constructEvent: vi.fn().mockImplementation((body: any) => {
        return typeof body === 'string' ? JSON.parse(body) : JSON.parse(body.toString());
      }),
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

describe('POST /api/admin/accounts/:orgId/sync — revenue_events backfill', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const TEST_ORG_ID = 'org_test_sync_backfill';
  const TEST_CUSTOMER_ID = 'cus_test_backfill';

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET stripe_customer_id = $3`,
      [TEST_ORG_ID, 'Sync Backfill Test Org', TEST_CUSTOMER_ID],
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM revenue_events WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    mockInvoicesList.mockImplementation(async function* () { yield FAKE_INVOICE; });
  });

  it('inserts a revenue_events row for a missed invoice and returns revenue_events_synced: 1', async () => {
    const response = await request(app)
      .post(`/api/admin/accounts/${TEST_ORG_ID}/sync`)
      .expect(200);

    expect(response.body.revenue_events_synced).toBe(1);

    const rows = await pool.query(
      'SELECT * FROM revenue_events WHERE workos_organization_id = $1',
      [TEST_ORG_ID],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].stripe_invoice_id).toBe(FAKE_INVOICE.id);
    expect(Number(rows.rows[0].amount_paid)).toBe(FAKE_INVOICE.amount_paid);
    expect(rows.rows[0].revenue_type).toBe('subscription_initial');
  });

  it('is idempotent — running sync twice does not duplicate revenue_events rows', async () => {
    const first = await request(app)
      .post(`/api/admin/accounts/${TEST_ORG_ID}/sync`)
      .expect(200);
    expect(first.body.revenue_events_synced).toBe(1);

    // Reset mock to return same invoice again
    mockInvoicesList.mockImplementation(async function* () { yield FAKE_INVOICE; });

    const second = await request(app)
      .post(`/api/admin/accounts/${TEST_ORG_ID}/sync`)
      .expect(200);
    expect(second.body.revenue_events_synced).toBe(0);

    const rows = await pool.query(
      'SELECT COUNT(*) AS count FROM revenue_events WHERE workos_organization_id = $1',
      [TEST_ORG_ID],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('returns revenue_events_synced: 0 when the row already exists (pre-written by webhook)', async () => {
    await pool.query(
      `INSERT INTO revenue_events (workos_organization_id, stripe_invoice_id, amount_paid, currency, revenue_type, paid_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [TEST_ORG_ID, FAKE_INVOICE.id, FAKE_INVOICE.amount_paid, FAKE_INVOICE.currency, 'subscription_initial'],
    );

    const response = await request(app)
      .post(`/api/admin/accounts/${TEST_ORG_ID}/sync`)
      .expect(200);

    expect(response.body.revenue_events_synced).toBe(0);

    const rows = await pool.query(
      'SELECT COUNT(*) AS count FROM revenue_events WHERE workos_organization_id = $1',
      [TEST_ORG_ID],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('returns 0 when the customer has no paid invoices', async () => {
    mockInvoicesList.mockImplementation(async function* () { /* no invoices */ });

    const response = await request(app)
      .post(`/api/admin/accounts/${TEST_ORG_ID}/sync`)
      .expect(200);

    expect(response.body.revenue_events_synced).toBe(0);
  });
});
