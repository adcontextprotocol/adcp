// lint-allow-test-imports-file: TODO(#3118-followup) — this suite uses
// dynamic-import-after-vi.mock to grab fresh mock refs per test. Convert to
// the vi.hoisted pattern so it can drop the resetModules + dynamic imports.
import { describe, test, expect, vi, beforeEach, type Mock } from 'vitest';
import type { MemberContext } from '../../server/src/addie/member-context.js';

const {
  mockGetOrganization,
  mockSearchOrganizations,
  mockGetOrCreateStripeCustomer,
  mockGetRelationshipByWorkosId,
  mockGetRelationshipBySlackId,
  mockRecordEvent,
} = vi.hoisted(() => {
  const mockGetOrganization = vi.fn<any>();
  const mockSearchOrganizations = vi.fn<any>();
  const mockGetOrCreateStripeCustomer = vi.fn<any>().mockImplementation(
    async (_orgId: string, createFn: () => Promise<string | null>) => createFn()
  );
  const mockGetRelationshipByWorkosId = vi.fn<any>();
  const mockGetRelationshipBySlackId = vi.fn<any>();
  const mockRecordEvent = vi.fn<any>().mockResolvedValue(undefined);
  return {
    mockGetOrganization,
    mockSearchOrganizations,
    mockGetOrCreateStripeCustomer,
    mockGetRelationshipByWorkosId,
    mockGetRelationshipBySlackId,
    mockRecordEvent,
  };
});

// Mock the stripe-client module
vi.mock('../../server/src/billing/stripe-client.js', () => ({
  getProductsForCustomer: vi.fn<any>(),
  createCheckoutSession: vi.fn<any>(),
  createAndSendInvoice: vi.fn<any>(),
  validateInvoiceDetails: vi.fn<any>(),
  createStripeCustomer: vi.fn<any>().mockResolvedValue('cus_new_123'),
  getPriceByLookupKey: vi.fn<any>(),
}));

// Mock the organization-db module
vi.mock('../../server/src/db/organization-db.js', () => {
  return {
    OrganizationDatabase: class {
      getOrganization = mockGetOrganization;
      searchOrganizations = mockSearchOrganizations;
      getOrCreateStripeCustomer = mockGetOrCreateStripeCustomer;
    },
  };
});

// Mock relationship + person-events modules so refusal-path tool_error
// emission doesn't try to hit a real DB pool.
vi.mock('../../server/src/db/relationship-db.js', () => ({
  getRelationshipByWorkosId: mockGetRelationshipByWorkosId,
  getRelationshipBySlackId: mockGetRelationshipBySlackId,
}));
vi.mock('../../server/src/db/person-events-db.js', () => ({
  recordEvent: mockRecordEvent,
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
    vi.clearAllMocks();
    vi.resetModules();
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
      (getProductsForCustomer as Mock).mockResolvedValue(mockProducts);

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
      (getProductsForCustomer as Mock)
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
      (getProductsForCustomer as Mock)
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
      (getProductsForCustomer as Mock).mockResolvedValue([]);

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
    test('returns error when no signed-in member context', async () => {
      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const createLink = handlers.get('create_payment_link')!;

      const result = await createLink({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/sign(?:ed)? in/i);
    });

    test('returns workspace-specific error when user has account but no organization', async () => {
      const contextWithUserNoOrg: MemberContext = {
        is_mapped: true,
        is_member: false,
        slack_linked: true,
        workos_user: {
          workos_user_id: 'user_no_org_123',
          email: 'james@example.com',
          first_name: 'James',
          last_name: 'Test',
        },
      };

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(contextWithUserNoOrg);
      const createLink = handlers.get('create_payment_link')!;

      const result = await createLink({ lookup_key: 'aao_membership_individual' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('no workspace');
      expect(parsed.error).toContain('complete onboarding');
    });

    test('creates payment link using memberContext email and stamps workosUserId', async () => {
      const { getPriceByLookupKey, createCheckoutSession, createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as Mock).mockResolvedValue('price_abc123');
      (createCheckoutSession as Mock).mockResolvedValue({
        url: 'https://checkout.stripe.com/c/pay/cs_test_xxx',
      });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const createLink = handlers.get('create_payment_link')!;

      // The tool schema no longer accepts customer_email; even if a caller sneaks
      // an extra property in, the handler must ignore it and use only the
      // memberContext email + user_id.
      const result = await createLink({
        lookup_key: 'aao_membership_corporate_5m',
        customer_email: 'hallucinated@example.com',
      } as unknown as Record<string, unknown>);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.payment_url).toBe('https://checkout.stripe.com/c/pay/cs_test_xxx');

      expect(getPriceByLookupKey).toHaveBeenCalledWith('aao_membership_corporate_5m');
      // Stripe customer is created with memberContext email + user_id metadata,
      // never the caller-supplied "hallucinated@example.com".
      expect(createStripeCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'irina@solutionsmarketingconsulting.com',
          metadata: expect.objectContaining({
            workos_organization_id: 'org_test_123',
            workos_user_id: 'user_test_123',
          }),
        })
      );
      // workosUserId is also passed through to checkout-session creation so the
      // subscription-created webhook can attribute deterministically via
      // resolveWorkosUserForSubscription.
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          priceId: 'price_abc123',
          customerId: 'cus_new_123',
          workosOrganizationId: 'org_test_123',
          workosUserId: 'user_test_123',
          isPersonalWorkspace: false,
        })
      );
    });

    test('refuses when memberContext has org but no workos_user email', async () => {
      const { getPriceByLookupKey, createCheckoutSession, createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as Mock).mockResolvedValue('price_abc123');
      (createCheckoutSession as Mock).mockResolvedValue({
        url: 'https://checkout.stripe.com/c/pay/cs_test_xxx',
      });

      // Slack-only context (no WorkOS user) — must refuse rather than fall
      // back to a Slack email or caller input.
      const slackOnlyContext: MemberContext = {
        is_mapped: false,
        is_member: false,
        slack_linked: true,
        slack_user: {
          slack_user_id: 'U123',
          display_name: 'Slack User',
          email: 'someone@slack.example.com',
        },
        organization: {
          workos_organization_id: 'org_test_123',
          name: 'Test Corp',
          subscription_status: 'active',
          is_personal: false,
        },
      };

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(slackOnlyContext);
      const createLink = handlers.get('create_payment_link')!;

      const result = await createLink({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/sign(?:ed)? in/i);
      expect(createStripeCustomer).not.toHaveBeenCalled();
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    test('returns error when price not found', async () => {
      const { getPriceByLookupKey } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as Mock).mockResolvedValue(null);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const createLink = handlers.get('create_payment_link')!;

      const result = await createLink({ lookup_key: 'invalid_key' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No product matches lookup_key');
      expect(parsed.error).toContain('invalid_key');
      expect(parsed.error).toContain('find_membership_products');
    });

    test('returns error when Stripe session creation fails', async () => {
      const { getPriceByLookupKey, createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');
      (getPriceByLookupKey as Mock).mockResolvedValue('price_abc123');
      (createCheckoutSession as Mock).mockResolvedValue(null);

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
    test('returns invoice preview using memberContext identity (no caller-supplied fields)', async () => {
      const { validateInvoiceDetails } = await import('../../server/src/billing/stripe-client.js');
      (validateInvoiceDetails as Mock).mockResolvedValue({
        amountDue: 150000,
        currency: 'usd',
        productName: 'Corporate Membership',
        discountApplied: false,
      });
      mockGetOrganization.mockResolvedValue({
        workos_organization_id: 'org_test_123',
        name: 'Test Corp',
        stripe_coupon_id: null,
        discount_percent: null,
        discount_amount_cents: null,
      });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const sendInvoice = handlers.get('send_invoice')!;

      const result = await sendInvoice({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      // Email comes from memberContext, not caller input
      expect(parsed.contact_email).toBe('irina@solutionsmarketingconsulting.com');
      expect(parsed.company_name).toBe('Test Corp');
      expect(parsed.amount).toContain('1,500');
      expect(parsed.product_name).toBe('Corporate Membership');
      expect(parsed.invoice_id).toBeUndefined();

      expect(validateInvoiceDetails).toHaveBeenCalledWith({
        lookupKey: 'aao_membership_corporate_5m',
        contactEmail: 'irina@solutionsmarketingconsulting.com',
        couponId: undefined,
      });
    });

    test('refuses without a signed-in member context', async () => {
      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const sendInvoice = handlers.get('send_invoice')!;

      const result = await sendInvoice({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/sign(?:ed)? in/i);
    });

    test('returns error when product not found', async () => {
      const { validateInvoiceDetails } = await import('../../server/src/billing/stripe-client.js');
      (validateInvoiceDetails as Mock).mockResolvedValue(null);
      mockGetOrganization.mockResolvedValue({
        workos_organization_id: 'org_test_123',
        name: 'Test Corp',
        stripe_coupon_id: null,
      });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const sendInvoice = handlers.get('send_invoice')!;

      const result = await sendInvoice({ lookup_key: 'invalid_key' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Product not found');
    });

    test('handles exceptions gracefully', async () => {
      const { validateInvoiceDetails } = await import('../../server/src/billing/stripe-client.js');
      (validateInvoiceDetails as Mock).mockRejectedValue(new Error('Stripe API error'));
      mockGetOrganization.mockResolvedValue({
        workos_organization_id: 'org_test_123',
        name: 'Test Corp',
        stripe_coupon_id: null,
      });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const sendInvoice = handlers.get('send_invoice')!;

      const result = await sendInvoice({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Failed to preview invoice');
    });
  });

  describe('confirm_send_invoice', () => {
    const orgWithBillingAddress = {
      workos_organization_id: 'org_test_123',
      name: 'Test Corp',
      stripe_coupon_id: null,
      discount_percent: null,
      discount_amount_cents: null,
      billing_address: {
        line1: '123 Test Street',
        city: 'London',
        state: 'Greater London',
        postal_code: 'EC1A 1BB',
        country: 'GB',
      },
    };

    test('creates and sends invoice using memberContext identity + org billing address', async () => {
      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');
      (createAndSendInvoice as Mock).mockResolvedValue({
        invoiceId: 'in_abc123',
        invoiceUrl: 'https://invoice.stripe.com/i/acct_xxx/test_xxx',
        subscriptionId: 'sub_xyz789',
        discountApplied: false,
      });
      mockGetOrganization.mockResolvedValue(orgWithBillingAddress);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const confirmSend = handlers.get('confirm_send_invoice')!;

      const result = await confirmSend({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.invoice_id).toBe('in_abc123');
      // Identity comes only from memberContext + org row, never from caller input
      expect(createAndSendInvoice).toHaveBeenCalledWith(expect.objectContaining({
        lookupKey: 'aao_membership_corporate_5m',
        contactEmail: 'irina@solutionsmarketingconsulting.com',
        companyName: 'Test Corp',
        billingAddress: orgWithBillingAddress.billing_address,
        workosOrganizationId: 'org_test_123',
      }));
    });

    test('refuses when org has no billing address on file', async () => {
      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');
      mockGetOrganization.mockResolvedValue({
        ...orgWithBillingAddress,
        billing_address: null,
      });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const confirmSend = handlers.get('confirm_send_invoice')!;

      const result = await confirmSend({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/billing address/i);
      expect(createAndSendInvoice).not.toHaveBeenCalled();
    });

    test('refuses without a signed-in member context', async () => {
      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers();
      const confirmSend = handlers.get('confirm_send_invoice')!;

      const result = await confirmSend({ lookup_key: 'aao_membership_corporate_5m' });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/sign(?:ed)? in/i);
    });

    test('returns error when invoice send fails', async () => {
      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');
      (createAndSendInvoice as Mock).mockResolvedValue(null);
      mockGetOrganization.mockResolvedValue(orgWithBillingAddress);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);
      const confirmSend = handlers.get('confirm_send_invoice')!;

      const result = await confirmSend({ lookup_key: 'aao_membership_corporate_5m' });
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
      expect(toolNames).toContain('confirm_send_invoice');
    });
  });

  // #3721 — every billing-tool refusal must leave a tool_error person event
  // so admins can debug failures from the timeline. Without these, send_invoice
  // can fail silently the way it did during the original incident.
  describe('refusal paths emit tool_error events', () => {
    const personId = 'person_test_abc';

    beforeEach(() => {
      mockGetRelationshipByWorkosId.mockResolvedValue({ id: personId });
      mockGetRelationshipBySlackId.mockResolvedValue(null);
      mockRecordEvent.mockResolvedValue(undefined);
    });

    test('send_invoice without a signed-in member emits tool_error and refuses', async () => {
      const billingTools = await import('../../server/src/addie/mcp/billing-tools.js');
      // Anonymous-on-Slack: no workos_user, but slack_user is present.
      const slackOnly: MemberContext = {
        is_mapped: false,
        is_member: false,
        slack_linked: true,
        slack_user: { slack_user_id: 'U_GREG', display_name: 'Greg', email: null },
      } as any;
      mockGetRelationshipByWorkosId.mockResolvedValue(null);
      mockGetRelationshipBySlackId.mockResolvedValue({ id: personId });

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(slackOnly);

      const result = JSON.parse(await handlers.get('send_invoice')({ lookup_key: 'aao_membership_explorer_50' }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sign in/i);

      expect(mockRecordEvent).toHaveBeenCalledWith(
        personId,
        'tool_error',
        expect.objectContaining({
          data: expect.objectContaining({
            tool: 'send_invoice',
            reason: 'not_signed_in_or_no_workspace',
            lookup_key: 'aao_membership_explorer_50',
          }),
        }),
      );
    });

    test('confirm_send_invoice without a billing address emits tool_error', async () => {
      mockGetOrganization.mockResolvedValue({
        workos_organization_id: 'org_test_123',
        name: 'Test Corp',
        billing_address: null,
      });
      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);

      const result = JSON.parse(await handlers.get('confirm_send_invoice')({
        lookup_key: 'aao_membership_explorer_50',
      }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/billing address/i);

      expect(mockRecordEvent).toHaveBeenCalledWith(
        personId,
        'tool_error',
        expect.objectContaining({
          data: expect.objectContaining({
            tool: 'confirm_send_invoice',
            reason: 'missing_billing_address',
            org_id: 'org_test_123',
          }),
        }),
      );
    });

    test('create_payment_link with bad lookup_key emits tool_error', async () => {
      const stripeMock = await import('../../server/src/billing/stripe-client.js');
      (stripeMock.getPriceByLookupKey as any).mockResolvedValue(null);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(mockMemberContext);

      const result = JSON.parse(await handlers.get('create_payment_link')({
        lookup_key: 'bogus_key_does_not_exist',
      }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No product matches/i);

      expect(mockRecordEvent).toHaveBeenCalledWith(
        personId,
        'tool_error',
        expect.objectContaining({
          data: expect.objectContaining({
            tool: 'create_payment_link',
            reason: 'unknown_lookup_key',
            lookup_key: 'bogus_key_does_not_exist',
          }),
        }),
      );
    });

    test('truly anonymous caller with no relationship row no-ops gracefully (no event)', async () => {
      mockGetRelationshipByWorkosId.mockResolvedValue(null);
      mockGetRelationshipBySlackId.mockResolvedValue(null);

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const handlers = createBillingToolHandlers(null);

      const result = JSON.parse(await handlers.get('send_invoice')!({ lookup_key: 'aao_membership_explorer_50' }));
      expect(result.success).toBe(false);
      expect(mockRecordEvent).not.toHaveBeenCalled();
    });

    test('recordEvent throwing does not break the user-facing refusal', async () => {
      mockRecordEvent.mockRejectedValueOnce(new Error('DB pool exhausted'));

      const { createBillingToolHandlers } = await import('../../server/src/addie/mcp/billing-tools.js');
      const noEmail: MemberContext = { ...mockMemberContext, workos_user: undefined } as any;
      const handlers = createBillingToolHandlers(noEmail);

      const result = JSON.parse(await handlers.get('send_invoice')!({ lookup_key: 'foo' }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sign in/i);
    });
  });
});
