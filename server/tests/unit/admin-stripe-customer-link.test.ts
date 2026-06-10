import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  mockPoolQuery,
  mockPoolConnect,
  mockCustomersRetrieve,
  mockCustomersUpdate,
  mockSubscriptionsList,
  mockSubscriptionsUpdate,
  mockInvoicesList,
  mockProductsRetrieve,
  mockInvalidateMembershipCache,
  stripeMockState,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn<any>(),
  mockPoolConnect: vi.fn<any>(),
  mockCustomersRetrieve: vi.fn<any>(),
  mockCustomersUpdate: vi.fn<any>(),
  mockSubscriptionsList: vi.fn<any>(),
  mockSubscriptionsUpdate: vi.fn<any>(),
  mockInvoicesList: vi.fn<any>(),
  mockProductsRetrieve: vi.fn<any>(),
  mockInvalidateMembershipCache: vi.fn<any>(),
  stripeMockState: { configured: true } as { configured: boolean },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_admin_01', email: 'admin@test', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireGlobalAdmin: [
    (req: any, _res: any, next: any) => {
      req.user = { id: 'user_admin_01', email: 'admin@test', is_admin: true };
      next();
    },
    (_req: any, _res: any, next: any) => next(),
  ],
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: () => mockPoolConnect(),
  }),
}));

vi.mock('../../src/db/org-filters.js', () => ({
  invalidateMembershipCache: (...args: unknown[]) => mockInvalidateMembershipCache(...args),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  get stripe() {
    if (!stripeMockState.configured) return null;
    return {
      customers: {
        retrieve: (...args: unknown[]) => mockCustomersRetrieve(...args),
        update: (...args: unknown[]) => mockCustomersUpdate(...args),
      },
      subscriptions: {
        list: (...args: unknown[]) => mockSubscriptionsList(...args),
        update: (...args: unknown[]) => mockSubscriptionsUpdate(...args),
      },
      invoices: {
        list: (...args: unknown[]) => mockInvoicesList(...args),
      },
      products: {
        retrieve: (...args: unknown[]) => mockProductsRetrieve(...args),
      },
    };
  },
  getBillingProducts: vi.fn(),
  getProductsForCustomer: vi.fn(),
  createProduct: vi.fn(),
  updateProductMetadata: vi.fn(),
  archiveProduct: vi.fn(),
  clearProductsCache: vi.fn(),
  getPendingInvoices: vi.fn(),
  voidInvoice: vi.fn(),
  deleteDraftInvoice: vi.fn(),
}));

const ORG_ID = 'org_link_target';
const CUSTOMER_ID = 'cus_link_target';
const LINK_REASON = 'correcting wrong Stripe customer link';

function makeOrgRow(overrides: Record<string, unknown> = {}) {
  return {
    workos_organization_id: ORG_ID,
    name: 'Link Target Org',
    stripe_customer_id: null,
    is_personal: false,
    subscription_status: null,
    stripe_subscription_id: null,
    subscription_amount: null,
    subscription_currency: null,
    subscription_interval: null,
    subscription_current_period_end: null,
    subscription_canceled_at: null,
    subscription_product_id: null,
    subscription_product_name: null,
    subscription_price_id: null,
    subscription_price_lookup_key: null,
    membership_tier: null,
    ...overrides,
  };
}

function makeMembershipCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    deleted: false,
    metadata: { workos_organization_id: ORG_ID },
    subscriptions: {
      data: [
        {
          id: 'sub_member_01',
          status: 'active',
          metadata: { workos_organization_id: ORG_ID },
          current_period_end: 1_800_000_000,
          canceled_at: null,
          items: {
            data: [{
              price: {
                id: 'price_member_01',
                product: { id: 'prod_member_01', name: 'Professional', metadata: { category: 'membership' } },
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
    ...overrides,
  };
}

function makeTxClient(opts?: { failOn?: 'UPDATE' | 'INSERT' }) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const trimmed = sql.trim();
    calls.push({ sql: trimmed, params });
    if (opts?.failOn === 'UPDATE' && trimmed.startsWith('UPDATE organizations')) {
      throw new Error('UPDATE failed');
    }
    if (opts?.failOn === 'INSERT' && trimmed.startsWith('INSERT INTO registry_audit_log')) {
      throw new Error('audit INSERT failed');
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  return { client: { query, release }, calls, query, release };
}

async function buildApp() {
  const { createBillingRouter } = await import('../../src/routes/billing.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createBillingRouter().apiRouter);
  return app;
}

describe('POST /api/admin/stripe-customers/:customerId/link', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockPoolConnect.mockReset();
    mockCustomersRetrieve.mockReset();
    mockCustomersUpdate.mockReset();
    mockSubscriptionsList.mockReset();
    mockSubscriptionsUpdate.mockReset();
    mockInvoicesList.mockReset();
    mockProductsRetrieve.mockReset();
    mockInvalidateMembershipCache.mockReset();
    stripeMockState.configured = true;
    mockSubscriptionsList.mockResolvedValue({ data: [] });
    mockInvoicesList.mockResolvedValue({ data: [] });
  });

  it('requires a reason before database or Stripe work', async () => {
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: 'too short' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reason required');
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockCustomersRetrieve).not.toHaveBeenCalled();
  });

  it('requires Stripe configuration before database work', async () => {
    stripeMockState.configured = false;
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: LINK_REASON });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Stripe not configured');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns 404 for missing Stripe customers before opening a transaction', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [makeOrgRow()] })
      .mockResolvedValueOnce({ rows: [] });
    mockCustomersRetrieve.mockRejectedValueOnce(Object.assign(new Error('No such customer'), {
      code: 'resource_missing',
      statusCode: 404,
    }));
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: LINK_REASON });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Stripe customer not found');
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('validates Stripe, updates the org, and records audit details in one transaction', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [makeOrgRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const customer = makeMembershipCustomer();
    mockCustomersRetrieve.mockResolvedValueOnce(customer);
    mockSubscriptionsList.mockResolvedValueOnce({ data: (customer as any).subscriptions.data });
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: LINK_REASON });

    expect(res.status).toBe(200);
    expect(mockCustomersRetrieve).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(mockSubscriptionsList).toHaveBeenCalledWith({
      customer: CUSTOMER_ID,
      status: 'all',
      limit: 100,
    });
    expect(tx.calls[0].sql).toBe('BEGIN');
    expect(tx.calls[tx.calls.length - 1].sql).toBe('COMMIT');

    const orgUpdate = tx.calls.find((call) =>
      call.sql.startsWith('UPDATE organizations SET stripe_customer_id'),
    );
    expect(orgUpdate?.params).toEqual([CUSTOMER_ID, ORG_ID]);

    const auditInsert = tx.calls.find((call) =>
      call.sql.startsWith('INSERT INTO registry_audit_log'),
    );
    expect(auditInsert).toBeTruthy();
    expect(auditInsert?.params?.slice(0, 5)).toEqual([
      ORG_ID,
      'user_admin_01',
      'admin_stripe_link',
      'subscription',
      CUSTOMER_ID,
    ]);
    const auditDetails = JSON.parse(String(auditInsert?.params?.[5]));
    expect(auditDetails.reason).toBe(LINK_REASON);
    expect(auditDetails.admin_email).toBe('admin@test');
    expect(auditDetails.before_state.stripe_customer_id).toBeNull();
    expect(auditDetails.after_state.stripe_customer_id).toBe(CUSTOMER_ID);
    expect(auditDetails.after_state.stripe_subscription_id).toBe('sub_member_01');
    expect(mockCustomersUpdate).toHaveBeenCalledWith(CUSTOMER_ID, {
      metadata: { workos_organization_id: ORG_ID },
    });
    expect(mockInvalidateMembershipCache).toHaveBeenCalledWith(ORG_ID);
  });

  it('repairs stale target-customer metadata when live subscriptions do not belong to another org', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [makeOrgRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const customer = makeMembershipCustomer({
      metadata: { workos_organization_id: 'org_stale_metadata' },
      subscriptions: {
        data: [{
          id: 'sub_no_org_metadata',
          status: 'active',
          metadata: {},
          current_period_end: 1_800_000_000,
          canceled_at: null,
          items: {
            data: [{
              price: {
                id: 'price_member_01',
                product: { id: 'prod_member_01', name: 'Professional', metadata: { category: 'membership' } },
                unit_amount: 25000,
                currency: 'usd',
                recurring: { interval: 'year' },
                lookup_key: 'aao_membership_professional_250',
              },
            }],
          },
        }],
      },
    });
    mockCustomersRetrieve.mockResolvedValueOnce(customer);
    mockSubscriptionsList.mockResolvedValueOnce({ data: (customer as any).subscriptions.data });
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: LINK_REASON });

    expect(res.status).toBe(200);
    expect(mockCustomersUpdate).toHaveBeenCalledWith(CUSTOMER_ID, {
      metadata: { workos_organization_id: ORG_ID },
    });
  });

  it('does not commit the org link when target customer metadata cannot be stamped', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [makeOrgRow()] })
      .mockResolvedValueOnce({ rows: [] });
    mockCustomersRetrieve.mockResolvedValueOnce(makeMembershipCustomer());
    mockSubscriptionsList.mockResolvedValueOnce({ data: [] });
    mockCustomersUpdate.mockRejectedValueOnce(new Error('Stripe metadata outage'));
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: LINK_REASON });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Stripe metadata update failed');
    expect(mockCustomersUpdate).toHaveBeenCalledWith(CUSTOMER_ID, {
      metadata: { workos_organization_id: ORG_ID },
    });
    expect(mockPoolConnect).toHaveBeenCalled();
    expect(tx.calls).toEqual([]);
    expect(tx.release).toHaveBeenCalled();
  });

  it('force-replaces an existing link, clears stale subscription state, and audits the replacement', async () => {
    const previousCustomerId = 'cus_previous_link';
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [makeOrgRow({
          stripe_customer_id: previousCustomerId,
          subscription_status: 'active',
          stripe_subscription_id: 'sub_previous',
          subscription_amount: 25000,
          subscription_currency: 'usd',
          subscription_interval: 'year',
          subscription_price_lookup_key: 'aao_membership_professional_250',
          membership_tier: 'individual_professional',
        })],
      })
      .mockResolvedValueOnce({ rows: [] });
    const customer = makeMembershipCustomer({
      subscriptions: {
        data: [{
          id: 'sub_event_only',
          status: 'active',
          metadata: { workos_organization_id: ORG_ID },
          current_period_end: 1_800_000_000,
          canceled_at: null,
          items: {
            data: [{
              price: {
                id: 'price_event_only',
                product: { id: 'prod_event_only', name: 'Event Ticket', metadata: { category: 'event' } },
                unit_amount: 5000,
                currency: 'usd',
                recurring: { interval: 'year' },
                lookup_key: 'aao_event_ticket_2026',
              },
            }],
          },
        }],
      },
    });
    mockCustomersRetrieve.mockResolvedValueOnce(customer);
    mockSubscriptionsList
      .mockResolvedValueOnce({ data: (customer as any).subscriptions.data })
      .mockResolvedValueOnce({
        data: [
          { id: 'sub_previous_keep_clear', metadata: { workos_organization_id: ORG_ID } },
          { id: 'sub_previous_no_org_meta', metadata: {} },
        ],
      });
    const tx = makeTxClient();
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, force: true, reason: LINK_REASON });

    expect(res.status).toBe(200);
    expect(res.body.previous_customer_id).toBe(previousCustomerId);

    const clearState = tx.calls.find((call) =>
      call.sql.startsWith('UPDATE organizations SET') &&
      call.sql.includes('stripe_subscription_id = NULL') &&
      call.sql.includes('subscription_currency = NULL'),
    );
    expect(clearState?.params).toEqual([ORG_ID]);

    const auditInsert = tx.calls.find((call) =>
      call.sql.startsWith('INSERT INTO registry_audit_log'),
    );
    expect(auditInsert?.params?.[2]).toBe('admin_stripe_link_replace');
    const auditDetails = JSON.parse(String(auditInsert?.params?.[5]));
    expect(auditDetails.previous_customer_id).toBe(previousCustomerId);
    expect(auditDetails.before_state.stripe_customer_id).toBe(previousCustomerId);
    expect(auditDetails.after_state.stripe_customer_id).toBe(CUSTOMER_ID);
    expect(auditDetails.after_state.stripe_subscription_id).toBeNull();

    expect(mockCustomersUpdate).toHaveBeenCalledWith(previousCustomerId, {
      metadata: { workos_organization_id: '' },
    });
    expect(mockSubscriptionsList).toHaveBeenCalledWith({
      customer: CUSTOMER_ID,
      status: 'all',
      limit: 100,
    });
    expect(mockSubscriptionsList).toHaveBeenCalledWith({
      customer: previousCustomerId,
      status: 'all',
      limit: 100,
    });
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_previous_keep_clear', {
      metadata: { workos_organization_id: '' },
    });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalledWith('sub_previous_no_org_meta', expect.anything());
    expect(mockCustomersUpdate).toHaveBeenCalledWith(CUSTOMER_ID, {
      metadata: { workos_organization_id: ORG_ID },
    });
    expect(mockInvalidateMembershipCache).toHaveBeenCalledWith(ORG_ID);
  });

  it('rolls back the org update if the audit insert fails', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [makeOrgRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const customer = makeMembershipCustomer({ metadata: {} });
    mockCustomersRetrieve.mockResolvedValueOnce(customer);
    mockSubscriptionsList.mockResolvedValueOnce({ data: (customer as any).subscriptions.data });
    const tx = makeTxClient({ failOn: 'INSERT' });
    mockPoolConnect.mockResolvedValueOnce(tx.client);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: LINK_REASON });

    expect(res.status).toBe(500);
    expect(tx.calls.map((call) => call.sql)).toContain('ROLLBACK');
    expect(tx.calls.map((call) => call.sql)).not.toContain('COMMIT');
    expect(mockCustomersUpdate).toHaveBeenCalledWith(CUSTOMER_ID, {
      metadata: { workos_organization_id: ORG_ID },
    });
    expect(mockCustomersUpdate).toHaveBeenCalledWith(CUSTOMER_ID, {
      metadata: { workos_organization_id: '' },
    });
    expect(tx.release).toHaveBeenCalled();
  });

  it('blocks live Stripe subscriptions associated with another organization before opening a transaction', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [makeOrgRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const customer = makeMembershipCustomer({
      metadata: { workos_organization_id: 'org_other_owner' },
      subscriptions: {
        data: [{
          id: 'sub_other_owner',
          status: 'active',
          metadata: { workos_organization_id: 'org_other_owner' },
          current_period_end: 1_800_000_000,
          canceled_at: null,
          items: { data: [] },
        }],
      },
    });
    mockCustomersRetrieve.mockResolvedValueOnce(customer);
    mockSubscriptionsList.mockResolvedValueOnce({ data: (customer as any).subscriptions.data });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/admin/stripe-customers/${CUSTOMER_ID}/link`)
      .send({ org_id: ORG_ID, reason: LINK_REASON });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Stripe customer belongs to another organization');
    expect(res.body.conflicting_org_ids).toEqual(['org_other_owner']);
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });
});
