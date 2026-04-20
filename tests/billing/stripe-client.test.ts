import { describe, test, expect, vi, beforeEach, type MockedClass } from 'vitest';
import type Stripe from 'stripe';

// Mock the Stripe module with a constructor that stores the latest mock instance
vi.mock('stripe', () => {
  const MockStripe = vi.fn();
  return { default: MockStripe };
});

describe('stripe-client', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
    // Reset modules to get fresh imports
    vi.resetModules();
  });

  describe('getStripeSubscriptionInfo', () => {
    test('returns null when Stripe is not initialized', async () => {
      // Set environment variable to undefined to disable Stripe
      const originalEnv = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;

      // Re-import module after changing env var
      const { getStripeSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getStripeSubscriptionInfo('cus_test123');

      expect(result).toBeNull();

      // Restore original env var
      if (originalEnv) {
        process.env.STRIPE_SECRET_KEY = originalEnv;
      }
    });

    test('returns status "none" for deleted customer', async () => {
      // Set a test Stripe key
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      // Mock Stripe SDK
      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: vi.fn<any>().mockResolvedValue({
            deleted: true,
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      // Re-import module to get mocked version
      const { getStripeSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getStripeSubscriptionInfo('cus_deleted');

      expect(result).toEqual({ status: 'none' });
      expect(mockStripeInstance.customers.retrieve).toHaveBeenCalledWith(
        'cus_deleted',
        { expand: ['subscriptions'] }
      );
    });

    test('returns status "none" for customer with no subscriptions', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: vi.fn<any>().mockResolvedValue({
            deleted: false,
            subscriptions: {
              data: [],
            },
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getStripeSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getStripeSubscriptionInfo('cus_nosubs');

      expect(result).toEqual({ status: 'none' });
    });

    test('returns subscription info for active subscription', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: vi.fn<any>().mockResolvedValue({
            deleted: false,
            subscriptions: {
              data: [{
                id: 'sub_123',
              }],
            },
          }),
        },
        subscriptions: {
          retrieve: vi.fn<any>().mockResolvedValue({
            status: 'active',
            current_period_end: 1234567890,
            cancel_at_period_end: false,
            latest_invoice: {
              period_end: 1234567890,
              period_start: 1234567000,
            },
            items: {
              data: [{
                price: {
                  product: {
                    id: 'prod_123',
                    name: 'Test Product',
                  },
                },
              }],
            },
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getStripeSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getStripeSubscriptionInfo('cus_active');

      expect(result).toEqual({
        status: 'active',
        product_id: 'prod_123',
        product_name: 'Test Product',
        current_period_end: 1234567890,
        cancel_at_period_end: false,
      });
    });

    test('handles errors gracefully and returns null', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: vi.fn<any>().mockRejectedValue(new Error('Stripe API error')),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getStripeSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getStripeSubscriptionInfo('cus_error');

      expect(result).toBeNull();
    });
  });

  describe('createStripeCustomer', () => {
    test('returns null when Stripe is not initialized', async () => {
      delete process.env.STRIPE_SECRET_KEY;

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'test@example.com',
        name: 'Test User',
      });

      expect(result).toBeNull();
    });

    test('creates customer and returns customer ID when no existing customer', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          list: vi.fn<any>().mockResolvedValue({ data: [] }),
          create: vi.fn<any>().mockResolvedValue({
            id: 'cus_new123',
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'test@example.com',
        name: 'Test User',
        metadata: { org_id: 'org_123' },
      });

      expect(result).toBe('cus_new123');
      expect(mockStripeInstance.customers.list).toHaveBeenCalledWith({
        email: 'test@example.com',
        limit: 1,
      });
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Test User',
        metadata: { org_id: 'org_123' },
      });
    });

    test('returns existing customer ID when customer already exists', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'cus_existing123', metadata: { existing_key: 'value' } }],
          }),
          update: vi.fn<any>().mockResolvedValue({ id: 'cus_existing123' }),
          create: vi.fn(),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'test@example.com',
        name: 'Test User',
        metadata: { org_id: 'org_123' },
      });

      expect(result).toBe('cus_existing123');
      expect(mockStripeInstance.customers.list).toHaveBeenCalledWith({
        email: 'test@example.com',
        limit: 1,
      });
      expect(mockStripeInstance.customers.update).toHaveBeenCalledWith('cus_existing123', {
        name: 'Test User',
        metadata: { existing_key: 'value', org_id: 'org_123' },
      });
      expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
    });

    test('handles errors and returns null', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          list: vi.fn<any>().mockRejectedValue(new Error('Stripe API error')),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'test@example.com',
        name: 'Test User',
      });

      expect(result).toBeNull();
    });

    test('searches by workos_organization_id metadata before email', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          search: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'cus_orgmatch', metadata: { workos_organization_id: 'org_abc' } }],
          }),
          update: vi.fn<any>().mockResolvedValue({ id: 'cus_orgmatch' }),
          list: vi.fn(),
          create: vi.fn(),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'different-user@example.com',
        name: 'Org Name',
        metadata: { workos_organization_id: 'org_abc' },
      });

      expect(result).toBe('cus_orgmatch');
      expect(mockStripeInstance.customers.search).toHaveBeenCalledWith({
        query: "metadata['workos_organization_id']:'org_abc'",
        limit: 1,
      });
      // Should NOT fall through to email check
      expect(mockStripeInstance.customers.list).not.toHaveBeenCalled();
      expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
    });

    test('falls through to email check when org metadata search returns empty', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          search: vi.fn<any>().mockResolvedValue({ data: [] }),
          list: vi.fn<any>().mockResolvedValue({ data: [] }),
          create: vi.fn<any>().mockResolvedValue({ id: 'cus_new456' }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'user@example.com',
        name: 'New Org',
        metadata: { workos_organization_id: 'org_xyz' },
      });

      expect(result).toBe('cus_new456');
      expect(mockStripeInstance.customers.search).toHaveBeenCalled();
      expect(mockStripeInstance.customers.list).toHaveBeenCalledWith({
        email: 'user@example.com',
        limit: 1,
      });
      expect(mockStripeInstance.customers.create).toHaveBeenCalled();
    });

    test('skips email-matched customer that belongs to a different org', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          search: vi.fn<any>().mockResolvedValue({ data: [] }),
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'cus_other_org', metadata: { workos_organization_id: 'org_different' } }],
          }),
          update: vi.fn<any>(),
          create: vi.fn<any>().mockResolvedValue({ id: 'cus_new_for_this_org' }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'shared@example.com',
        name: 'Org B',
        metadata: { workos_organization_id: 'org_requesting' },
      });

      expect(result).toBe('cus_new_for_this_org');
      expect(mockStripeInstance.customers.list).toHaveBeenCalled();
      // Should not update the skipped customer
      expect(mockStripeInstance.customers.update).not.toHaveBeenCalled();
      // Should create a new one
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        email: 'shared@example.com',
        name: 'Org B',
        metadata: { workos_organization_id: 'org_requesting' },
      });
    });

    test('skips email-matched customer with no org metadata when requesting org is set', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          search: vi.fn<any>().mockResolvedValue({ data: [] }),
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'cus_orphan', metadata: {} }],
          }),
          update: vi.fn<any>(),
          create: vi.fn<any>().mockResolvedValue({ id: 'cus_brand_new' }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'shared@example.com',
        name: 'Org C',
        metadata: { workos_organization_id: 'org_requesting' },
      });

      expect(result).toBe('cus_brand_new');
      expect(mockStripeInstance.customers.update).not.toHaveBeenCalled();
      expect(mockStripeInstance.customers.create).toHaveBeenCalled();
    });
  });

  describe('createCustomerPortalSession', () => {
    test('returns null when Stripe is not initialized', async () => {
      delete process.env.STRIPE_SECRET_KEY;

      const { createCustomerPortalSession } = await import('../../server/src/billing/stripe-client.js');

      const result = await createCustomerPortalSession('cus_123', 'http://localhost/return');

      expect(result).toBeNull();
    });

    test('creates portal session and returns URL', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        billingPortal: {
          sessions: {
            create: vi.fn<any>().mockResolvedValue({
              url: 'https://billing.stripe.com/session/test',
            }),
          },
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCustomerPortalSession } = await import('../../server/src/billing/stripe-client.js');

      const result = await createCustomerPortalSession('cus_123', 'http://localhost/return');

      expect(result).toBe('https://billing.stripe.com/session/test');
      expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_123',
        return_url: 'http://localhost/return',
      });
    });
  });

  describe('createCustomerSession', () => {
    test('returns null when Stripe is not initialized', async () => {
      delete process.env.STRIPE_SECRET_KEY;

      const { createCustomerSession } = await import('../../server/src/billing/stripe-client.js');

      const result = await createCustomerSession('cus_123');

      expect(result).toBeNull();
    });

    test('creates customer session and returns client secret', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customerSessions: {
          create: vi.fn<any>().mockResolvedValue({
            client_secret: 'cs_test_secret123',
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCustomerSession } = await import('../../server/src/billing/stripe-client.js');

      const result = await createCustomerSession('cus_123');

      expect(result).toBe('cs_test_secret123');
      expect(mockStripeInstance.customerSessions.create).toHaveBeenCalledWith({
        customer: 'cus_123',
        components: {
          pricing_table: {
            enabled: true,
          },
        },
      });
    });
  });

  describe('createAndSendInvoice', () => {
    const validInvoiceData = {
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
    };

    test('returns null when Stripe is not initialized', async () => {
      delete process.env.STRIPE_SECRET_KEY;

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).toBeNull();
    });

    test('creates subscription with invoice billing and returns invoice details', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000, // $10,000
            currency: 'usd',
          }),
        },
        customers: {
          list: vi.fn<any>().mockResolvedValue({ data: [] }),
          create: vi.fn<any>().mockResolvedValue({
            id: 'cus_new123',
            email: 'ruben.schreurs@ebiquity.com',
          }),
          update: vi.fn<any>().mockResolvedValue({
            id: 'cus_new123',
            email: 'ruben.schreurs@ebiquity.com',
          }),
        },
        subscriptions: {
          create: vi.fn<any>().mockResolvedValue({
            id: 'sub_xyz789',
            latest_invoice: 'in_abc123',
          }),
        },
        invoices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'in_abc123',
            amount_due: 1000000,
          }),
          sendInvoice: vi.fn<any>().mockResolvedValue({
            id: 'in_abc123',
            hosted_invoice_url: 'https://invoice.stripe.com/i/acct_xxx/test_xxx',
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).not.toBeNull();
      expect(result?.invoiceId).toBe('in_abc123');
      expect(result?.subscriptionId).toBe('sub_xyz789');
      expect(result?.invoiceUrl).toBe('https://invoice.stripe.com/i/acct_xxx/test_xxx');

      // Verify subscription was created with correct parameters
      expect(mockStripeInstance.subscriptions.create).toHaveBeenCalledWith({
        customer: 'cus_new123',
        items: [{ price: 'price_abc123' }],
        collection_method: 'send_invoice',
        days_until_due: 30,
        metadata: expect.objectContaining({
          lookup_key: 'aao_membership_corporate_5m',
          contact_name: 'Ruben Schreurs',
        }),
      });
    });

    test('returns null when price has zero amount', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 0, // Zero amount - should fail
            currency: 'usd',
          }),
        },
        customers: {
          list: vi.fn<any>().mockResolvedValue({ data: [] }),
          create: vi.fn<any>().mockResolvedValue({
            id: 'cus_new123',
            email: 'test@example.com',
          }),
          update: vi.fn<any>().mockResolvedValue({ id: 'cus_new123' }),
        },
        subscriptions: {
          create: vi.fn(),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).toBeNull();
      // Subscription should not have been created because price validation happens first
      expect(mockStripeInstance.subscriptions.create).not.toHaveBeenCalled();
    });

    test('cancels subscription when invoice has zero amount', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000, // Valid price
            currency: 'usd',
          }),
        },
        customers: {
          list: vi.fn<any>().mockResolvedValue({ data: [] }),
          create: vi.fn<any>().mockResolvedValue({
            id: 'cus_new123',
            email: 'test@example.com',
          }),
          update: vi.fn<any>().mockResolvedValue({ id: 'cus_new123' }),
        },
        subscriptions: {
          create: vi.fn<any>().mockResolvedValue({
            id: 'sub_xyz789',
            latest_invoice: 'in_abc123',
          }),
          cancel: vi.fn<any>().mockResolvedValue({ id: 'sub_xyz789' }),
        },
        invoices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'in_abc123',
            amount_due: 0, // Zero amount invoice - should cancel subscription
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).toBeNull();
      // Subscription should have been cancelled
      expect(mockStripeInstance.subscriptions.cancel).toHaveBeenCalledWith('sub_xyz789');
    });

    test('returns null when lookup key not found', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>().mockResolvedValue({
            data: [], // No prices found
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice({
        ...validInvoiceData,
        lookupKey: 'invalid_lookup_key',
      });

      expect(result).toBeNull();
    });

    test('uses existing customer when found by email', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000,
            currency: 'usd',
          }),
        },
        customers: {
          list: vi.fn<any>().mockResolvedValue({
            data: [{ id: 'cus_existing123', email: 'ruben.schreurs@ebiquity.com' }],
          }),
          update: vi.fn<any>().mockResolvedValue({
            id: 'cus_existing123',
            email: 'ruben.schreurs@ebiquity.com',
          }),
          create: vi.fn(),
        },
        subscriptions: {
          create: vi.fn<any>().mockResolvedValue({
            id: 'sub_xyz789',
            latest_invoice: 'in_abc123',
          }),
        },
        invoices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'in_abc123',
            amount_due: 1000000,
          }),
          sendInvoice: vi.fn<any>().mockResolvedValue({
            id: 'in_abc123',
            hosted_invoice_url: 'https://invoice.stripe.com/i/acct_xxx/test_xxx',
          }),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).not.toBeNull();
      // Should update existing customer, not create new
      expect(mockStripeInstance.customers.update).toHaveBeenCalledWith('cus_existing123', expect.any(Object));
      expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
    });
  });

  describe('createCheckoutSession', () => {
    test('includes subscription_data.metadata with org ID for subscription-mode checkout', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockSession = {
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/test',
      };
      const mockStripeInstance = {
        prices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_test',
            recurring: { interval: 'year' },
          }),
        },
        checkout: {
          sessions: {
            create: vi.fn<any>().mockResolvedValue(mockSession),
          },
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');

      await createCheckoutSession({
        priceId: 'price_test',
        customerEmail: 'test@example.com',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
        workosOrganizationId: 'org_test_123',
        workosUserId: 'user_test_456',
        isPersonalWorkspace: true,
      });

      const createCall = mockStripeInstance.checkout.sessions.create.mock.calls[0][0] as any;
      expect(createCall.subscription_data).toBeDefined();
      expect(createCall.subscription_data.metadata.workos_organization_id).toBe('org_test_123');
      expect(createCall.subscription_data.metadata.workos_user_id).toBeUndefined();
    });

    test('does not include subscription_data for one-time payment checkout', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockSession = {
        id: 'cs_test_456',
        url: 'https://checkout.stripe.com/test2',
      };
      const mockStripeInstance = {
        prices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_onetime',
            recurring: null,
          }),
        },
        checkout: {
          sessions: {
            create: vi.fn<any>().mockResolvedValue(mockSession),
          },
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');

      await createCheckoutSession({
        priceId: 'price_onetime',
        customerEmail: 'test@example.com',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
        workosOrganizationId: 'org_test_123',
        workosUserId: 'user_test_456',
        isPersonalWorkspace: false,
      });

      const createCall = mockStripeInstance.checkout.sessions.create.mock.calls[0][0] as any;
      expect(createCall.subscription_data).toBeUndefined();
    });
  });

  describe('resolveLookupKeyAlias', () => {
    const products = [
      { lookup_key: 'aao_membership_explorer_50', price_id: 'price_explorer' },
      { lookup_key: 'aao_membership_professional_250', price_id: 'price_professional' },
      { lookup_key: 'aao_membership_builder_3000', price_id: 'price_builder' },
      { lookup_key: 'aao_membership_individual', price_id: 'price_individual' },
      { lookup_key: 'aao_membership_individual_discounted', price_id: 'price_individual_discounted' },
    ] as any[];

    test('resolves "<tier>_annual" to canonical key when unique', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      expect(resolveLookupKeyAlias('explorer_annual', products)?.lookup_key)
        .toBe('aao_membership_explorer_50');
      expect(resolveLookupKeyAlias('professional_annual', products)?.lookup_key)
        .toBe('aao_membership_professional_250');
    });

    test('resolves bare tier name to canonical key', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      expect(resolveLookupKeyAlias('builder', products)?.lookup_key)
        .toBe('aao_membership_builder_3000');
    });

    test('handles uppercase and whitespace in input', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      expect(resolveLookupKeyAlias('  EXPLORER_ANNUAL ', products)?.lookup_key)
        .toBe('aao_membership_explorer_50');
    });

    test('returns undefined for unknown alias', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      expect(resolveLookupKeyAlias('nonexistent_tier', products)).toBeUndefined();
    });

    test('returns undefined for empty input', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      expect(resolveLookupKeyAlias('', products)).toBeUndefined();
      expect(resolveLookupKeyAlias('   ', products)).toBeUndefined();
    });

    test('refuses ambiguous resolution: "individual" matches two products', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      // "individual" would match both aao_membership_individual and
      // aao_membership_individual_discounted — must refuse rather than guess.
      expect(resolveLookupKeyAlias('individual', products)).toBeUndefined();
    });

    test('refuses ambiguous resolution: annual/monthly collision', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      const catalog = [
        { lookup_key: 'aao_membership_professional_250', price_id: 'price_pro_annual' },
        { lookup_key: 'aao_membership_professional_monthly', price_id: 'price_pro_monthly' },
      ] as any[];
      // Must NOT silently pick the annual SKU when the LLM asks for "monthly".
      expect(resolveLookupKeyAlias('professional_annual', catalog)).toBeUndefined();
      expect(resolveLookupKeyAlias('professional', catalog)).toBeUndefined();
    });

    test('refuses ambiguous resolution: multi-tier corporate catalog', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      const catalog = [
        { lookup_key: 'aao_membership_corporate_5m', price_id: 'price_5m' },
        { lookup_key: 'aao_membership_corporate_50m', price_id: 'price_50m' },
        { lookup_key: 'aao_membership_corporate_under5m', price_id: 'price_under5m' },
      ] as any[];
      expect(resolveLookupKeyAlias('corporate', catalog)).toBeUndefined();
      expect(resolveLookupKeyAlias('corporate_annual', catalog)).toBeUndefined();
    });

    test('still resolves corporate variant when input is specific enough', async () => {
      const { resolveLookupKeyAlias } = await import('../../server/src/billing/stripe-client.js');
      const catalog = [
        { lookup_key: 'aao_membership_corporate_5m', price_id: 'price_5m' },
        { lookup_key: 'aao_membership_corporate_50m', price_id: 'price_50m' },
        { lookup_key: 'aao_membership_corporate_under5m', price_id: 'price_under5m' },
      ] as any[];
      expect(resolveLookupKeyAlias('corporate_5m', catalog)?.lookup_key)
        .toBe('aao_membership_corporate_5m');
      expect(resolveLookupKeyAlias('corporate_under5m', catalog)?.lookup_key)
        .toBe('aao_membership_corporate_under5m');
    });
  });
});
