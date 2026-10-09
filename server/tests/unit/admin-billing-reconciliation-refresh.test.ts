import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPoolQuery,
  mockCustomerRetrieve,
  mockSubscriptionList,
  mockInvoiceList,
  mockProductRetrieve,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn<any>(),
  mockCustomerRetrieve: vi.fn<any>(),
  mockSubscriptionList: vi.fn<any>(),
  mockInvoiceList: vi.fn<any>(),
  mockProductRetrieve: vi.fn<any>(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_admin', email: 'admin@example.test', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/middleware/organization-authorization-observer.js', () => ({
  excludeOrganizationAuthorizationObservation: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: {
    customers: { retrieve: (...args: unknown[]) => mockCustomerRetrieve(...args) },
    subscriptions: { list: (...args: unknown[]) => mockSubscriptionList(...args) },
    invoices: { list: (...args: unknown[]) => mockInvoiceList(...args) },
    products: { retrieve: (...args: unknown[]) => mockProductRetrieve(...args) },
  },
}));

async function buildApp() {
  const { setupAccountsBillingRoutes } = await import('../../src/routes/admin/accounts-billing.js');
  const router = express.Router();
  setupAccountsBillingRoutes(router, { workos: null });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  return app;
}

describe('POST /api/admin/accounts/:orgId/sync billing reconciliation', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockCustomerRetrieve.mockReset();
    mockSubscriptionList.mockReset();
    mockInvoiceList.mockReset();
    mockProductRetrieve.mockReset();

    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT workos_organization_id, stripe_customer_id, is_personal')) {
        return {
          rows: [{
            workos_organization_id: 'org_reconcile',
            stripe_customer_id: 'cus_reconcile',
            is_personal: false,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    mockCustomerRetrieve.mockResolvedValue({ id: 'cus_reconcile', deleted: false });
    mockSubscriptionList.mockResolvedValue({
      data: [{
        id: 'sub_reconcile',
        status: 'active',
        current_period_end: 1_800_000_000,
        canceled_at: null,
        items: { data: [{ price: {
          id: 'price_reconcile',
          unit_amount: 250000,
          currency: 'usd',
          recurring: { interval: 'year' },
          lookup_key: 'aao_membership_professional_250',
          product: 'prod_reconcile',
        } }] },
      }],
    });
    mockInvoiceList.mockReturnValue({
      data: [],
      has_more: false,
      async *[Symbol.asyncIterator]() { /* no paid invoices */ },
    });
  });

  it('refreshes only local state and records a redacted refresh outcome', async () => {
    const response = await request(await buildApp())
      .post('/api/admin/accounts/org_reconcile/sync');

    expect(response.status).toBe(200);
    expect(response.body.stripe).toMatchObject({
      success: true,
      subscription: { status: 'active' },
    });
    expect(response.body.invoices_synced).toBe(0);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('admin_billing_reconciliation_events'),
      expect.arrayContaining([
        'user_admin',
        'cus_reconcile',
        'org_reconcile',
        'success',
      ]),
    );
    expect(mockPoolQuery.mock.calls.at(-1)?.[1]?.join(' ')).not.toContain('admin@example.test');
    expect(mockCustomerRetrieve).toHaveBeenCalledWith('cus_reconcile');
    expect(mockSubscriptionList).toHaveBeenCalledWith({
      customer: 'cus_reconcile',
      status: 'all',
      limit: 10,
    });
  });

  it('reports and audits a failed invoice-cache refresh as failed', async () => {
    mockInvoiceList.mockRejectedValue({
      code: 'api_connection_error',
      statusCode: 503,
      message: 'private@example.test timed out',
    });

    const response = await request(await buildApp())
      .post('/api/admin/accounts/org_reconcile/sync');

    expect(response.status).toBe(200);
    expect(response.body.stripe).toEqual({
      success: false,
      error: 'Failed to sync from Stripe',
    });
    const auditCall = mockPoolQuery.mock.calls.find(([sql]) =>
      String(sql).includes('admin_billing_reconciliation_events'));
    expect(auditCall?.[1]).toEqual(expect.arrayContaining([
      'user_admin',
      'cus_reconcile',
      'org_reconcile',
      'failed',
    ]));
    expect(JSON.stringify(auditCall)).not.toContain('private@example.test');
  });
});
