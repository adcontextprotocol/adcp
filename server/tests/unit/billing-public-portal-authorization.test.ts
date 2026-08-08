import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.WORKOS_API_KEY ||= 'sk_test_billing_auth';
process.env.WORKOS_CLIENT_ID ||= 'client_test_billing_auth';
process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-minimum';

const {
  mockListMemberships,
  mockGetOrganization,
  mockGetSubscriptionInfo,
  mockGetCurrentAgreement,
  mockUpdateOrganization,
  mockGetProducts,
  mockCreatePortal,
  mockCreateInvoice,
  mockCreateCheckout,
  mockGetAcceptedReferral,
  mockWithOrgIntakeLock,
} = vi.hoisted(() => ({
  mockListMemberships: vi.fn(),
  mockGetOrganization: vi.fn(),
  mockGetSubscriptionInfo: vi.fn(),
  mockGetCurrentAgreement: vi.fn(),
  mockUpdateOrganization: vi.fn(),
  mockGetProducts: vi.fn(),
  mockCreatePortal: vi.fn(),
  mockCreateInvoice: vi.fn(),
  mockCreateCheckout: vi.fn(),
  mockGetAcceptedReferral: vi.fn(),
  mockWithOrgIntakeLock: vi.fn(),
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships: mockListMemberships,
    };
  },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  DEV_USERS: {},
  isDevModeEnabled: () => false,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'user_billing',
      email: 'billing@example.test',
      firstName: 'Billing',
      lastName: 'Tester',
      emailVerified: true,
      is_admin: false,
    };
    next();
  },
}));

vi.mock('../../src/db/organization-db.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db/organization-db.js')>();
  return {
    ...original,
    OrganizationDatabase: class {
      getOrganization = mockGetOrganization;
      getSubscriptionInfo = mockGetSubscriptionInfo;
      getCurrentAgreementByType = mockGetCurrentAgreement;
      updateOrganization = mockUpdateOrganization;
    },
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  getProductsForCustomer: mockGetProducts,
  createAndSendInvoice: mockCreateInvoice,
  getInvoiceableProducts: vi.fn(),
  createCheckoutSession: mockCreateCheckout,
  createCoupon: vi.fn(),
  getPendingInvoices: vi.fn(),
  createStripeCustomer: vi.fn(),
  createCustomerSession: vi.fn(),
  createCustomerPortalSession: mockCreatePortal,
}));

vi.mock('../../src/billing/org-intake-lock.js', () => ({
  withOrgIntakeLock: mockWithOrgIntakeLock,
}));

vi.mock('../../src/db/referral-codes-db.js', () => ({
  getReferralCode: vi.fn(),
  redeemReferralCodeForInvoice: vi.fn(),
  getAcceptedReferralForOrg: mockGetAcceptedReferral,
  acceptReferralCode: vi.fn(),
}));

vi.mock('../../src/notifications/billing.js', () => ({
  notifyInvoiceSent: vi.fn().mockResolvedValue(undefined),
}));

const { createPublicBillingRouter } = await import('../../src/routes/billing-public.js');

const ORG_ID = 'org_billing';
const ACTIVE_SUBSCRIPTION = {
  status: 'active',
  product_name: 'Company Membership',
  amount_cents: 300000,
};

function membership(
  role: 'owner' | 'admin' | 'member',
  options: { status?: 'active' | 'inactive'; organizationId?: string } = {},
) {
  return {
    id: `om_${role}`,
    userId: 'user_billing',
    organizationId: options.organizationId ?? ORG_ID,
    role: { slug: role },
    status: options.status ?? 'active',
  };
}

function membershipPage(...rows: ReturnType<typeof membership>[]) {
  return { data: rows };
}

const invoiceBody = {
  orgId: ORG_ID,
  lookupKey: 'aao_company_standard',
  agreement_version: 'v1',
  billingAddress: {
    line1: '100 Main Street',
    city: 'New York',
    state: 'NY',
    postal_code: '10001',
    country: 'US',
  },
};

const checkoutBody = {
  orgId: ORG_ID,
  priceId: 'price_company_standard',
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(createPublicBillingRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOrganization.mockResolvedValue({
    workos_organization_id: ORG_ID,
    name: 'Acme Corp',
    is_personal: false,
    stripe_customer_id: 'cus_billing',
    subscription_status: null,
    pending_agreement_version: null,
    agreement_version: null,
  });
  mockGetCurrentAgreement.mockResolvedValue({ version: 'v1' });
  mockUpdateOrganization.mockResolvedValue(undefined);
  mockGetProducts.mockResolvedValue([{
    lookup_key: 'aao_company_standard',
    price_id: 'price_company_standard',
    display_name: 'Company Membership',
    amount_cents: 300000,
    currency: 'usd',
  }]);
  mockCreatePortal.mockResolvedValue('https://billing.stripe.test/portal');
  mockCreateInvoice.mockResolvedValue({
    invoiceId: 'in_test',
    invoiceUrl: 'https://invoice.stripe.test/in_test',
  });
  mockCreateCheckout.mockResolvedValue({
    sessionId: 'cs_test',
    url: 'https://checkout.stripe.test/cs_test',
  });
  mockGetAcceptedReferral.mockResolvedValue(null);
  mockWithOrgIntakeLock.mockImplementation(async (_orgId: string, fn: () => Promise<unknown>) => fn());
});

describe.each([
  ['invoice request', '/invoice-request', invoiceBody],
  ['checkout session', '/checkout-session', checkoutBody],
] as const)('%s portal authorization', (_label, path, body) => {
  it('returns a portal-free 409 to an ordinary member with an active subscription', async () => {
    mockListMemberships.mockResolvedValue(membershipPage(membership('member')));
    mockGetSubscriptionInfo.mockResolvedValue(ACTIVE_SUBSCRIPTION);

    const response = await request(createApp()).post(path).send(body);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Active subscription exists');
    expect(response.body).not.toHaveProperty('customer_portal_url');
    expect(mockCreatePortal).not.toHaveBeenCalled();
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockCreateCheckout).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('returns a portal URL to an active %s', async (role) => {
    mockListMemberships.mockResolvedValue(membershipPage(membership(role)));
    mockGetSubscriptionInfo.mockResolvedValue(ACTIVE_SUBSCRIPTION);

    const response = await request(createApp()).post(path).send(body);

    expect(response.status).toBe(409);
    expect(response.body.customer_portal_url).toBe('https://billing.stripe.test/portal');
    expect(mockCreatePortal).toHaveBeenCalledWith(
      'cus_billing',
      expect.stringContaining('/dashboard/membership'),
    );
  });

  it.each([
    ['inactive owner', membership('owner', { status: 'inactive' })],
    ['owner for another org', membership('owner', { organizationId: 'org_other' })],
  ])('rejects an %s before any Stripe call', async (_case, row) => {
    mockListMemberships.mockResolvedValue(membershipPage(row));

    const response = await request(createApp()).post(path).send(body);

    expect(response.status).toBe(403);
    expect(mockGetSubscriptionInfo).not.toHaveBeenCalled();
    expect(mockGetProducts).not.toHaveBeenCalled();
    expect(mockCreatePortal).not.toHaveBeenCalled();
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockCreateCheckout).not.toHaveBeenCalled();
  });
});

describe('invoice request in-lock authorization', () => {
  it('fails closed when membership is revoked while waiting for the lock', async () => {
    mockListMemberships
      .mockResolvedValueOnce(membershipPage(membership('owner')))
      .mockResolvedValueOnce(membershipPage());
    mockGetSubscriptionInfo.mockResolvedValueOnce(null);

    const response = await request(createApp()).post('/invoice-request').send(invoiceBody);

    expect(response.status).toBe(403);
    expect(mockListMemberships).toHaveBeenCalledTimes(2);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockCreatePortal).not.toHaveBeenCalled();
  });

  it('preserves member intake but suppresses the raced portal after an owner downgrade', async () => {
    mockListMemberships
      .mockResolvedValueOnce(membershipPage(membership('owner')))
      .mockResolvedValueOnce(membershipPage(membership('member')));
    mockGetSubscriptionInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ACTIVE_SUBSCRIPTION);

    const response = await request(createApp()).post('/invoice-request').send(invoiceBody);

    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('customer_portal_url');
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockCreatePortal).not.toHaveBeenCalled();
  });

  it('lets an ordinary member reach the existing invoice success path when no subscription is active', async () => {
    mockListMemberships.mockResolvedValue(membershipPage(membership('member')));
    mockGetSubscriptionInfo.mockResolvedValue(null);

    const response = await request(createApp()).post('/invoice-request').send(invoiceBody);

    expect(response.status).toBe(200);
    expect(response.body.invoiceId).toBe('in_test');
    expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
    expect(mockCreatePortal).not.toHaveBeenCalled();
  });
});

describe('checkout member intake', () => {
  it('fails closed when membership is revoked during product discovery', async () => {
    mockListMemberships
      .mockResolvedValueOnce(membershipPage(membership('owner')))
      .mockResolvedValueOnce(membershipPage());

    const response = await request(createApp()).post('/checkout-session').send(checkoutBody);

    expect(response.status).toBe(403);
    expect(mockListMemberships).toHaveBeenCalledTimes(2);
    expect(mockGetProducts).toHaveBeenCalledTimes(1);
    expect(mockGetSubscriptionInfo).not.toHaveBeenCalled();
    expect(mockCreatePortal).not.toHaveBeenCalled();
    expect(mockCreateCheckout).not.toHaveBeenCalled();
  });

  it('suppresses the portal when an owner is downgraded during product discovery', async () => {
    mockListMemberships
      .mockResolvedValueOnce(membershipPage(membership('owner')))
      .mockResolvedValueOnce(membershipPage(membership('member')));
    mockGetSubscriptionInfo.mockResolvedValue(ACTIVE_SUBSCRIPTION);

    const response = await request(createApp()).post('/checkout-session').send(checkoutBody);

    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('customer_portal_url');
    expect(mockListMemberships).toHaveBeenCalledTimes(2);
    expect(mockCreatePortal).not.toHaveBeenCalled();
    expect(mockCreateCheckout).not.toHaveBeenCalled();
  });

  it('lets an ordinary member reach the existing checkout success path when no subscription is active', async () => {
    mockListMemberships.mockResolvedValue(membershipPage(membership('member')));
    mockGetSubscriptionInfo.mockResolvedValue(null);

    const response = await request(createApp()).post('/checkout-session').send(checkoutBody);

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe('cs_test');
    expect(mockListMemberships).toHaveBeenCalledTimes(2);
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
    expect(mockCreatePortal).not.toHaveBeenCalled();
  });
});
