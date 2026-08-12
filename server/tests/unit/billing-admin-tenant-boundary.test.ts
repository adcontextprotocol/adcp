import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createProduct: vi.fn(),
  getProductsForCustomer: vi.fn(),
  getOrganization: vi.fn(),
  findStripeCustomerConflicts: vi.fn(),
  getOrganizationByStripeCustomerId: vi.fn(),
  setStripeCustomerId: vi.fn(),
  unlinkStripeCustomer: vi.fn(),
  customersRetrieve: vi.fn(),
  customersUpdate: vi.fn(),
  isWebUserAAOAdmin: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_billing_tenant_boundary';
  process.env.WORKOS_CLIENT_ID = 'client_test_billing_tenant_boundary';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
});

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: (...args: unknown[]) => mocks.isWebUserAAOAdmin(...args),
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();

  return {
    ...actual,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        id: 'user_billing_boundary',
        email: 'billing-boundary@example.test',
        emailVerified: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };

      const apiKeyOrgId = req.header('x-test-api-key-org-id');
      if (apiKeyOrgId) {
        (req as Request & {
          apiKey?: {
            id: string;
            organizationId: string;
            name: string;
            permissions: string[];
          };
        }).apiKey = {
          id: 'apikey_owner_automation',
          organizationId: apiKeyOrgId,
          name: 'Owner automation',
          permissions: ['admin:*'],
        };
      }

      if (req.header('x-test-static-admin') === '1') {
        (req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey = true;
      }
      next();
    },
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: {
    customers: {
      retrieve: (...args: unknown[]) => mocks.customersRetrieve(...args),
      update: (...args: unknown[]) => mocks.customersUpdate(...args),
    },
    invoices: {},
    products: {},
    subscriptions: {},
  },
  getBillingProducts: vi.fn(),
  getProductsForCustomer: (...args: unknown[]) => mocks.getProductsForCustomer(...args),
  createProduct: (...args: unknown[]) => mocks.createProduct(...args),
  updateProductMetadata: vi.fn(),
  archiveProduct: vi.fn(),
  clearProductsCache: vi.fn(),
  getPendingInvoices: vi.fn(),
  voidInvoice: vi.fn(),
  deleteDraftInvoice: vi.fn(),
}));

vi.mock('../../src/db/organization-db.js', () => ({
  OrganizationDatabase: class OrganizationDatabase {
    getOrganization = (...args: unknown[]) => mocks.getOrganization(...args);
    findStripeCustomerConflicts = (...args: unknown[]) =>
      mocks.findStripeCustomerConflicts(...args);
    getOrganizationByStripeCustomerId = (...args: unknown[]) =>
      mocks.getOrganizationByStripeCustomerId(...args);
    setStripeCustomerId = (...args: unknown[]) => mocks.setStripeCustomerId(...args);
    unlinkStripeCustomer = (...args: unknown[]) => mocks.unlinkStripeCustomer(...args);
  },
  TIER_PRESERVING_STATUSES: new Set(),
  buildSubscriptionUpdate: vi.fn(),
}));

const { createBillingRouter } = await import('../../src/routes/billing.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');

const app = express();
app.use(express.json());
app.use('/api/admin', createBillingRouter().apiRouter);

afterAll(() => {
  stopAuthTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrganization.mockResolvedValue({
    workos_organization_id: 'org_owner',
    name: 'Acme Corp',
    discount_percent: null,
    discount_amount_cents: null,
    stripe_coupon_id: null,
    discount_reason: null,
  });
  mocks.getProductsForCustomer.mockResolvedValue([]);
  mocks.findStripeCustomerConflicts.mockResolvedValue([]);
  mocks.createProduct.mockResolvedValue({
    product_id: 'prod_platform',
    price_id: 'price_platform',
    lookup_key: 'aao_platform_product',
  });
  mocks.isWebUserAAOAdmin.mockResolvedValue(true);
});

describe('billing admin tenant boundary', () => {
  it('allows owner automation only on an explicitly scoped route for its own organization', async () => {
    const response = await request(app)
      .get('/api/admin/orgs/org_owner/invite-products')
      .set('x-test-api-key-org-id', 'org_owner');

    expect(response.status).toBe(200);
    expect(mocks.getOrganization).toHaveBeenCalledWith('org_owner');
    expect(mocks.getProductsForCustomer).toHaveBeenCalledWith({ invoiceableOnly: true });
  });

  it('refuses the same owner automation key on a sibling organization', async () => {
    const response = await request(app)
      .get('/api/admin/orgs/org_sibling/invite-products')
      .set('x-test-api-key-org-id', 'org_owner');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('cross_tenant_api_key');
    expect(mocks.getOrganization).not.toHaveBeenCalled();
    expect(mocks.getProductsForCustomer).not.toHaveBeenCalled();
  });

  it('refuses owner automation before platform-global product creation', async () => {
    const response = await request(app)
      .post('/api/admin/products')
      .set('x-test-api-key-org-id', 'org_owner')
      .send({
        name: 'Platform product',
        lookupKey: 'aao_platform_product',
        amountCents: 1000,
        billingType: 'one_time',
        category: 'other',
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('global_admin_required');
    expect(mocks.createProduct).not.toHaveBeenCalled();
  });

  it('refuses owner automation before Stripe-conflict resolution side effects', async () => {
    const response = await request(app)
      .post('/api/admin/stripe-conflicts/resolve')
      .set('x-test-api-key-org-id', 'org_owner')
      .send({
        stripe_customer_id: 'cus_conflict',
        keep_org_id: 'org_sibling',
        action: 'update_stripe_metadata',
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('global_admin_required');
    expect(mocks.getOrganizationByStripeCustomerId).not.toHaveBeenCalled();
    expect(mocks.customersUpdate).not.toHaveBeenCalled();
  });

  it('keeps platform-global billing routes available to the static admin key', async () => {
    const productResponse = await request(app)
      .post('/api/admin/products')
      .set('x-test-static-admin', '1')
      .send({
        name: 'Platform product',
        lookupKey: 'aao_platform_product',
        amountCents: 1000,
        billingType: 'one_time',
        category: 'other',
      });
    const conflictsResponse = await request(app)
      .get('/api/admin/stripe-conflicts')
      .set('x-test-static-admin', '1');

    expect(productResponse.status).toBe(200);
    expect(mocks.createProduct).toHaveBeenCalledOnce();
    expect(conflictsResponse.status).toBe(200);
    expect(mocks.findStripeCustomerConflicts).toHaveBeenCalledOnce();
  });

  it('keeps platform-global billing routes available to an SSO platform admin', async () => {
    const productResponse = await request(app)
      .post('/api/admin/products')
      .send({
        name: 'Platform product',
        lookupKey: 'aao_platform_product',
        amountCents: 1000,
        billingType: 'one_time',
        category: 'other',
      });

    expect(productResponse.status).toBe(200);
    expect(mocks.isWebUserAAOAdmin).toHaveBeenCalledWith('user_billing_boundary');
    expect(mocks.createProduct).toHaveBeenCalledOnce();
  });
});
