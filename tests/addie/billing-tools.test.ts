import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import type { MemberContext } from '../../server/src/addie/member-context.js';

// Mock the stripe-client module
jest.mock('../../server/src/billing/stripe-client.js', () => ({
  getProductsForCustomer: jest.fn(),
  createCheckoutSession: jest.fn(),
  createAndSendInvoice: jest.fn(),
  createStripeCustomer: jest.fn().mockResolvedValue('cus_new_123'),
  getPriceByLookupKey: jest.fn(),
}));

// Mock the organization-db module
const mockGetOrganization = jest.fn();
const mockSearchOrganizations = jest.fn();
const mockGetOrCreateStripeCustomer = jest.fn().mockImplementation(
  async (_orgId: string, createFn: () => Promise<string | null>) => createFn()
);
jest.mock('../../server/src/db/organization-db.js', () => ({
  OrganizationDatabase: jest.fn().mockImplementation(() => ({
    getOrganization: mockGetOrganization,
    searchOrganizations: mockSearchOrganizations,
    getOrCreateStripeCustomer: mockGetOrCreateStripeCustomer,
  })),
}));

/** Member context with an organization for payment link tests */
const mockMemberContext: MemberContext = {
  is_mapped: true,
  is_member: true,
  slack_linked: false,
  organization: {
    workos_organization_id: 'org_test_123',
    name: 'Test Corp',
    subscription_status: 'active',
    is_personal: false,
  },
  workos_user: {
    workos_user_id: 'user_test_123',
    email: 'irina@solutionsmarketingconsulting.com',
    first_name: 'Irina',
    last_name: 'Test',
  },
};

describe('billing-tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockGetOrganization.mockResolvedValue(null);
    mockSearchOrganizations.mockResolvedValue([]);
  });

  describe('find_membership_products', () => {
    test('returns formatted products when products are found', async () => {
      const mockProducts = [
        {
          lookup_key: 'aao_membership_corporate_5m',
          product_name: 'Corporate Membership',
          display_name: 'Bronze Membership',
          description: 'Annual corporate membership',
          amount_cents: 1000000, // $10,000
          currency: 'usd',
          billing_type: 'subscription',
          billing_interval: 'year',
          is_invoiceable: true,
          revenue_tiers: ['5m_50m'],
          customer_types: ['company'],
          category: 'membership',
        },
        {
          lookup_key: 'aao_membership_corporate_50m',
          product_name: 'Silver Membership',
          display_name: 'Silver Membership',
          description: 'Annual corporate membership for larger companies',
          amount_cents: 2500000, // $25,000
          currency: 'usd',
          billing_type: 'subscription',
          billing_interval: 'year',
          is_invoiceable: true,
          revenue_tiers: ['50m_250m'],
          customer_types: ['company'],
          category: 'membership',
        },
      ];

      const { getProductsForCustomer } = await import('../../server/src/billing/stripe-client.js');
      (getProductsForCustomer as jest.Mock).mockResolvedValue(mockProducts);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const findProducts = handlers.get('find_membership_products')!;

      const result = await findProducts({ customer_type: 'company' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.products).toHaveLength(2);
      expect(parsed.products[0]).toEqual({
        name: 'Bronze Membership',
        description: 'Annual corporate membership',
        price: '$10,000.00',
        billing: 'yearly subscription',
        lookup_key: 'aao_membership_corporate_5m',
        can_invoice: true,
        revenue_tiers: '$5M - $50M',
      });
      expect(parsed.message).toContain('Found 2 product(s)');
    });

    test('returns error message when no products found and no products exist', async () => {
      const { getProductsForCustomer } = await import('../../server/src/billing/stripe-client.js');
      // First call (with filters) returns empty, second call (without filters) also returns empty
      (getProductsForCustomer as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const findProducts = handlers.get('find_membership_products')!;

      const result = await findProducts({ customer_type: 'company' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain('Unable to access billing products');
      expect(parsed.message).toContain('configuration issue');
    });

    test('returns helpful message when no products match filters but products exist', async () => {
      const mockProducts = [
        {
          lookup_key: 'aao_membership_individual',
          product_name: 'Individual Membership',
          display_name: 'Individual Membership',
          description: 'Individual membership',
          amount_cents: 50000,
          currency: 'usd',
          billing_type: 'subscription',
          billing_interval: 'year',
          is_invoiceable: false,
          revenue_tiers: [],
          customer_types: ['individual'],
          category: 'membership',
        },
      ];

      const { getProductsForCustomer } = await import('../../server/src/billing/stripe-client.js');
      // First call (with filters) returns empty, second call (without filters) returns products
      (getProductsForCustomer as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(mockProducts);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const findProducts = handlers.get('find_membership_products')!;

      const result = await findProducts({ customer_type: 'company', revenue_tier: '1b_plus' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain('No membership products found matching the criteria');
      expect(parsed.message).toContain('customer_type: company');
      expect(parsed.message).toContain('revenue_tier: 1b_plus');
    });

    test('filters by revenue tier correctly', async () => {
      const { getProductsForCustomer } = await import('../../server/src/billing/stripe-client.js');
      (getProductsForCustomer as jest.Mock).mockResolvedValue([]);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const findProducts = handlers.get('find_membership_products')!;

      await findProducts({ customer_type: 'company', revenue_tier: '50m_250m' });

      expect(getProductsForCustomer).toHaveBeenCalledWith({
        customerType: 'company',
        revenueTier: '50m_250m',
        category: 'membership',
      });
    });
  });

  describe('create_payment_link', () => {
    test('returns error when no account context is provided', async () => {
      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const createLink = handlers.get('create_payment_link')!;

      const result = await createLink({
        lookup_key: 'aao_membership_corporate_5m',
        customer_email: 'test@example.com',
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Cannot create a payment link without an account');
    });

    test('creates payment link using memberContext email by default', async () => {
      const { getPriceByLookupKey, createCheckoutSession, createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as jest.Mock).mockResolvedValue('price_abc123');
      (createCheckoutSession as jest.Mock).mockResolvedValue({
        url: 'https://checkout.stripe.com/c/pay/cs_test_xxx',
      });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const createLink = handlers.get('create_payment_link')!;

      // Even when AI passes a different email, the real user email from context is used
      const result = await createLink({
        lookup_key: 'aao_membership_corporate_5m',
        customer_email: 'hallucinated@example.com',
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.payment_url).toBe('https://checkout.stripe.com/c/pay/cs_test_xxx');
      expect(parsed.message).toContain('Payment link created successfully');

      expect(getPriceByLookupKey).toHaveBeenCalledWith('aao_membership_corporate_5m');
      // Should pre-create a Stripe customer with the memberContext email
      expect(createStripeCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'irina@solutionsmarketingconsulting.com',
          metadata: { workos_organization_id: 'org_test_123' },
        })
      );
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          priceId: 'price_abc123',
          customerId: 'cus_new_123',
          workosOrganizationId: 'org_test_123',
          isPersonalWorkspace: false,
        })
      );
    });

    test('falls back to AI-provided email when memberContext has no email', async () => {
      const { getPriceByLookupKey, createCheckoutSession, createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as jest.Mock).mockResolvedValue('price_abc123');
      (createCheckoutSession as jest.Mock).mockResolvedValue({
        url: 'https://checkout.stripe.com/c/pay/cs_test_xxx',
      });

      // Member context without email info
      const contextWithoutEmail: MemberContext = {
        is_mapped: true,
        is_member: true,
        slack_linked: false,
        organization: {
          workos_organization_id: 'org_test_123',
          name: 'Test Corp',
          subscription_status: 'active',
          is_personal: false,
        },
      };

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(contextWithoutEmail);
      const createLink = handlers.get('create_payment_link')!;

      await createLink({
        lookup_key: 'aao_membership_corporate_5m',
        customer_email: 'user@company.com',
      });

      // Should pre-create a Stripe customer with the AI-provided email
      expect(createStripeCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'user@company.com',
          metadata: { workos_organization_id: 'org_test_123' },
        })
      );
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cus_new_123',
        })
      );
    });

    test('falls back to AI-provided email when slack_user.email is null', async () => {
      const { getPriceByLookupKey, createCheckoutSession, createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as jest.Mock).mockResolvedValue('price_abc123');
      (createCheckoutSession as jest.Mock).mockResolvedValue({
        url: 'https://checkout.stripe.com/c/pay/cs_test_xxx',
      });

      // Member context with slack_user but null email
      const contextWithNullEmail: MemberContext = {
        is_mapped: true,
        is_member: true,
        slack_linked: true,
        slack_user: {
          slack_user_id: 'U123',
          display_name: 'Irina',
          email: null,
        },
        organization: {
          workos_organization_id: 'org_test_123',
          name: 'Test Corp',
          subscription_status: 'active',
          is_personal: false,
        },
      };

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(contextWithNullEmail);
      const createLink = handlers.get('create_payment_link')!;

      await createLink({
        lookup_key: 'aao_membership_corporate_5m',
        customer_email: 'user@company.com',
      });

      // Should pre-create a Stripe customer with the AI-provided email
      expect(createStripeCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'user@company.com',
          metadata: { workos_organization_id: 'org_test_123' },
        })
      );
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cus_new_123',
        })
      );
    });

    test('returns error when price not found', async () => {
      const { getPriceByLookupKey } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as jest.Mock).mockResolvedValue(null);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const createLink = handlers.get('create_payment_link')!;

      const result = await createLink({ lookup_key: 'invalid_key' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Product not found');
      expect(parsed.error).toContain('invalid_key');
    });

    test('returns error when Stripe session creation fails', async () => {
      const { getPriceByLookupKey, createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as jest.Mock).mockResolvedValue('price_abc123');
      (createCheckoutSession as jest.Mock).mockResolvedValue(null);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const createLink = handlers.get('create_payment_link')!;

      const result = await createLink({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Stripe is not configured');
    });
  });

  describe('send_invoice', () => {
    test('sends invoice successfully with subscription', async () => {
      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');
      (createAndSendInvoice as jest.Mock).mockResolvedValue({
        invoiceId: 'in_abc123',
        invoiceUrl: 'https://invoice.stripe.com/i/acct_xxx/test_xxx',
        subscriptionId: 'sub_xyz789',
      });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const sendInvoice = handlers.get('send_invoice')!;

      const result = await sendInvoice({
        lookup_key: 'aao_membership_corporate_5m',
        company_name: 'Ebiquity Plc',
        contact_name: 'Ruben Schreurs',
        contact_email: 'ruben.schreurs@ebiquity.com',
        billing_address: {
          line1: '123 Test Street',
          city: 'London',
          state: 'Greater London',
          postal_code: 'EC1A 1BB',
          country: 'GB',
        },
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.invoice_id).toBe('in_abc123');
      expect(parsed.invoice_url).toBe('https://invoice.stripe.com/i/acct_xxx/test_xxx');
      expect(parsed.message).toContain('Invoice sent to ruben.schreurs@ebiquity.com');

      expect(createAndSendInvoice).toHaveBeenCalledWith({
        lookupKey: 'aao_membership_corporate_5m',
        companyName: 'Ebiquity Plc',
        contactName: 'Ruben Schreurs',
        contactEmail: 'ruben.schreurs@ebiquity.com',
        billingAddress: {
          line1: '123 Test Street',
          city: 'London',
          state: 'Greater London',
          postal_code: 'EC1A 1BB',
          country: 'GB',
        },
      });
    });

    test('returns error when invoice creation fails', async () => {
      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');
      (createAndSendInvoice as jest.Mock).mockResolvedValue(null);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const sendInvoice = handlers.get('send_invoice')!;

      const result = await sendInvoice({
        lookup_key: 'invalid_key',
        company_name: 'Test Corp',
        contact_name: 'Test User',
        contact_email: 'test@example.com',
        billing_address: {
          line1: '123 Test Street',
          city: 'New York',
          state: 'NY',
          postal_code: '10001',
          country: 'US',
        },
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Failed to send invoice');
      expect(parsed.error).toContain('Stripe may not be configured');
    });

    test('handles exceptions gracefully', async () => {
      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');
      (createAndSendInvoice as jest.Mock).mockRejectedValue(new Error('Stripe API error'));

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const sendInvoice = handlers.get('send_invoice')!;

      const result = await sendInvoice({
        lookup_key: 'aao_membership_corporate_5m',
        company_name: 'Test Corp',
        contact_name: 'Test User',
        contact_email: 'test@example.com',
        billing_address: {
          line1: '123 Test Street',
          city: 'New York',
          state: 'NY',
          postal_code: '10001',
          country: 'US',
        },
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Failed to send invoice');
    });
  });

  describe('tool handler registration', () => {
    test('all billing tools have handlers registered', async () => {
      const { createBillingToolHandlers, BILLING_TOOLS } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();

      for (const tool of BILLING_TOOLS) {
        expect(handlers.has(tool.name)).toBe(true);
        expect(typeof handlers.get(tool.name)).toBe('function');
      }
    });

    test('BILLING_TOOLS array contains expected tools', async () => {
      const { BILLING_TOOLS } = await import('../../server/src/addie/mcp/billing-tools.js');

      const toolNames = BILLING_TOOLS.map(t => t.name);
      expect(toolNames).toContain('find_membership_products');
      expect(toolNames).toContain('create_payment_link');
      expect(toolNames).toContain('send_invoice');
    });
  });
});
