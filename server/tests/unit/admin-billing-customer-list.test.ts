import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPoolQuery,
  mockCustomersList,
  mockCustomersSearch,
  mockCustomersRetrieve,
  mockCustomersUpdate,
  mockInvoicesList,
  stripeMockState,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn<any>(),
  mockCustomersList: vi.fn<any>(),
  mockCustomersSearch: vi.fn<any>(),
  mockCustomersRetrieve: vi.fn<any>(),
  mockCustomersUpdate: vi.fn<any>(),
  mockInvoicesList: vi.fn<any>(),
  stripeMockState: { configured: true } as { configured: boolean },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireTenantAdminForOrganization: (_req: any, _res: any, next: any) => next(),
  requireGlobalAdmin: [
    (req: any, _res: any, next: any) => {
      req.user = { id: 'user_admin', email: 'admin@example.test', is_admin: true };
      next();
    },
  ],
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
  }),
}));

vi.mock('../../src/db/org-filters.js', () => ({
  invalidateMembershipCache: vi.fn(),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  get stripe() {
    if (!stripeMockState.configured) return null;
    return {
      customers: {
        list: (...args: unknown[]) => mockCustomersList(...args),
        search: (...args: unknown[]) => mockCustomersSearch(...args),
        retrieve: (...args: unknown[]) => mockCustomersRetrieve(...args),
        update: (...args: unknown[]) => mockCustomersUpdate(...args),
      },
      invoices: {
        list: (...args: unknown[]) => mockInvoicesList(...args),
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

function makeCustomer(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: 'customer',
    name: `${id} name`,
    email: `${id}@example.test`,
    created: 1_700_000_000,
    currency: 'usd',
    default_source: null,
    invoice_settings: { default_payment_method: null },
    subscriptions: { data: [], has_more: false, object: 'list', url: '/v1/subscriptions' },
    ...overrides,
  };
}

async function buildApp() {
  const { createBillingRouter } = await import('../../src/routes/billing.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createBillingRouter().apiRouter);
  return app;
}

describe('GET /api/admin/stripe-customers', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockCustomersList.mockReset();
    mockCustomersSearch.mockReset();
    mockCustomersRetrieve.mockReset();
    mockCustomersUpdate.mockReset();
    mockInvoicesList.mockReset();
    stripeMockState.configured = true;

    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockCustomersList.mockResolvedValue({ data: [], has_more: false });
    mockCustomersSearch.mockResolvedValue({
      data: [],
      has_more: false,
      next_page: null,
      total_count: 0,
    });
    mockInvoicesList.mockResolvedValue({ data: [], has_more: false });
  });

  it('loads one bounded customer page and resolves only those organization links', async () => {
    mockCustomersList.mockResolvedValue({
      data: [makeCustomer('cus_first'), makeCustomer('cus_second')],
      has_more: true,
    });
    mockPoolQuery.mockResolvedValue({
      rows: [{
        workos_organization_id: 'org_first',
        name: 'First Org',
        stripe_customer_id: 'cus_first',
      }],
    });

    const response = await request(await buildApp()).get('/api/admin/stripe-customers');

    expect(response.status).toBe(200);
    expect(mockCustomersList).toHaveBeenCalledWith({
      limit: 25,
      expand: ['data.subscriptions'],
    });
    expect(mockPoolQuery.mock.calls[0][0]).toContain('stripe_customer_id = ANY($1::text[])');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([['cus_first', 'cus_second']]);
    expect(response.body.customers[0].linked_org).toEqual({ id: 'org_first', name: 'First Org' });
    expect(response.body.pagination).toEqual({
      count: 2,
      total: null,
      limit: 25,
      has_more: true,
      next_cursor: 'cus_second',
    });
    expect(mockInvoicesList).toHaveBeenCalledTimes(4);
  });

  it('passes bounded list cursors through to Stripe', async () => {
    const response = await request(await buildApp())
      .get('/api/admin/stripe-customers?limit=10&cursor=cus_previous');

    expect(response.status).toBe(200);
    expect(mockCustomersList).toHaveBeenCalledWith({
      limit: 10,
      starting_after: 'cus_previous',
      expand: ['data.subscriptions'],
    });
  });

  it('searches organization name and contact email with a total/count contract', async () => {
    mockCustomersSearch.mockResolvedValue({
      data: [makeCustomer('cus_search')],
      has_more: true,
      next_page: 'search_page_2',
      total_count: 7,
    });

    const response = await request(await buildApp())
      .get('/api/admin/stripe-customers?q=Acme%27s%5C%5CMedia&limit=20');

    expect(response.status).toBe(200);
    expect(mockCustomersSearch).toHaveBeenCalledOnce();
    expect(mockCustomersSearch.mock.calls[0][0]).toMatchObject({
      limit: 20,
      expand: ['data.subscriptions', 'total_count'],
    });
    expect(mockCustomersSearch.mock.calls[0][0].query).toContain("name~'Acme\\'s\\\\\\\\Media'");
    expect(mockCustomersSearch.mock.calls[0][0].query).toContain("email~'Acme\\'s\\\\\\\\Media'");
    expect(response.body.count).toBe(1);
    expect(response.body.total).toBe(7);
    expect(response.body.pagination.next_cursor).toBe('search_page_2');
  });

  it('looks up an exact Stripe customer ID without scanning or searching', async () => {
    mockCustomersRetrieve.mockResolvedValue(makeCustomer('cus_exact123'));

    const response = await request(await buildApp())
      .get('/api/admin/stripe-customers?q=cus_exact123');

    expect(response.status).toBe(200);
    expect(mockCustomersRetrieve).toHaveBeenCalledWith('cus_exact123', {
      expand: ['subscriptions'],
    });
    expect(mockCustomersList).not.toHaveBeenCalled();
    expect(mockCustomersSearch).not.toHaveBeenCalled();
    expect(response.body.total).toBe(1);
  });

  it('returns an empty result for a missing exact Stripe customer ID', async () => {
    mockCustomersRetrieve.mockRejectedValue({ code: 'resource_missing', statusCode: 404 });

    const response = await request(await buildApp())
      .get('/api/admin/stripe-customers?q=cus_missing123');

    expect(response.status).toBe(200);
    expect(response.body.customers).toEqual([]);
    expect(response.body.total).toBe(0);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('filters billing and subscription statuses server-side', async () => {
    mockCustomersList.mockResolvedValue({
      data: [
        makeCustomer('cus_linked', {
          subscriptions: { data: [{ status: 'active' }] },
        }),
        makeCustomer('cus_unlinked'),
      ],
      has_more: false,
    });
    mockPoolQuery.mockResolvedValue({
      rows: [{
        workos_organization_id: 'org_linked',
        name: 'Linked Org',
        stripe_customer_id: 'cus_linked',
      }],
    });
    mockInvoicesList.mockImplementation(async (params: { customer: string; status: string }) => ({
      data: params.customer === 'cus_unlinked' && params.status === 'paid'
        ? [{ amount_paid: 12500 }]
        : [],
    }));

    const unlinked = await request(await buildApp())
      .get('/api/admin/stripe-customers?status=unlinked-payments');
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.customers.map((customer: any) => customer.id)).toEqual(['cus_unlinked']);
    expect(unlinked.body.total).toBeNull();

    const active = await request(await buildApp())
      .get('/api/admin/stripe-customers?status=active');
    expect(active.status).toBe(200);
    expect(active.body.customers.map((customer: any) => customer.id)).toEqual(['cus_linked']);

    mockInvoicesList.mockImplementation(async (params: { customer: string; status: string }) => ({
      data: params.customer === 'cus_linked' && params.status === 'open'
        ? [{ amount_due: 2500 }]
        : [],
    }));
    const open = await request(await buildApp())
      .get('/api/admin/stripe-customers?status=open');
    expect(open.status).toBe(200);
    expect(open.body.customers.map((customer: any) => customer.id)).toEqual(['cus_linked']);
  });

  it.each([
    ['/api/admin/stripe-customers?limit=51', 'limit must be an integer'],
    ['/api/admin/stripe-customers?status=made_up', 'Invalid customer status filter'],
  ])('rejects invalid pagination and filters before external work: %s', async (path, error) => {
    const response = await request(await buildApp()).get(path);

    expect(response.status).toBe(400);
    expect(response.body.error).toContain(error);
    expect(mockCustomersList).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('admin billing customer search UI', () => {
  const html = readFileSync(
    fileURLToPath(new URL('../../public/admin-billing.html', import.meta.url)),
    'utf8',
  );

  it('provides search, status, paging, empty, and URL-preservation states', () => {
    expect(html).toContain('id="customer-search-form"');
    expect(html).toContain('placeholder="Organization, contact email, or cus_…"');
    expect(html).toContain('id="customer-status"');
    expect(html).toContain('id="customers-empty"');
    expect(html).toContain('id="customer-page-previous"');
    expect(html).toContain('id="customer-page-next"');
    expect(html).toContain("params.set('cursor', currentCustomerCursor)");
    expect(html).toContain('window.history.replaceState');
  });
});
