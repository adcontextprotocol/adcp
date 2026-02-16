import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import type Stripe from 'stripe';

// Mock the Stripe module
jest.mock('stripe');

describe('stripe-client', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    // Reset modules to get fresh imports
    jest.resetModules();
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
      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: jest.fn().mockResolvedValue({
            deleted: true,
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: jest.fn().mockResolvedValue({
            deleted: false,
            subscriptions: {
              data: [],
            },
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

      const { getStripeSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getStripeSubscriptionInfo('cus_nosubs');

      expect(result).toEqual({ status: 'none' });
    });

    test('returns subscription info for active subscription', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: jest.fn().mockResolvedValue({
            deleted: false,
            subscriptions: {
              data: [{
                id: 'sub_123',
              }],
            },
          }),
        },
        subscriptions: {
          retrieve: jest.fn().mockResolvedValue({
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
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          retrieve: jest.fn().mockRejectedValue(new Error('Stripe API error')),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          list: jest.fn().mockResolvedValue({ data: [] }),
          create: jest.fn().mockResolvedValue({
            id: 'cus_new123',
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          list: jest.fn().mockResolvedValue({
            data: [{ id: 'cus_existing123', metadata: { existing_key: 'value' } }],
          }),
          update: jest.fn().mockResolvedValue({ id: 'cus_existing123' }),
          create: jest.fn(),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          list: jest.fn().mockRejectedValue(new Error('Stripe API error')),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

      const { createStripeCustomer } = await import('../../server/src/billing/stripe-client.js');

      const result = await createStripeCustomer({
        email: 'test@example.com',
        name: 'Test User',
      });

      expect(result).toBeNull();
    });

    test('searches by workos_organization_id metadata before email', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          search: jest.fn().mockResolvedValue({
            data: [{ id: 'cus_orgmatch', metadata: { workos_organization_id: 'org_abc' } }],
          }),
          update: jest.fn().mockResolvedValue({ id: 'cus_orgmatch' }),
          list: jest.fn(),
          create: jest.fn(),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          search: jest.fn().mockResolvedValue({ data: [] }),
          list: jest.fn().mockResolvedValue({ data: [] }),
          create: jest.fn().mockResolvedValue({ id: 'cus_new456' }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        billingPortal: {
          sessions: {
            create: jest.fn().mockResolvedValue({
              url: 'https://billing.stripe.com/session/test',
            }),
          },
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customerSessions: {
          create: jest.fn().mockResolvedValue({
            client_secret: 'cs_test_secret123',
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: jest.fn().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: jest.fn().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000, // $10,000
            currency: 'usd',
          }),
        },
        customers: {
          list: jest.fn().mockResolvedValue({ data: [] }),
          create: jest.fn().mockResolvedValue({
            id: 'cus_new123',
            email: 'ruben.schreurs@ebiquity.com',
          }),
          update: jest.fn().mockResolvedValue({
            id: 'cus_new123',
            email: 'ruben.schreurs@ebiquity.com',
          }),
        },
        subscriptions: {
          create: jest.fn().mockResolvedValue({
            id: 'sub_xyz789',
            latest_invoice: 'in_abc123',
          }),
        },
        invoices: {
          retrieve: jest.fn().mockResolvedValue({
            id: 'in_abc123',
            amount_due: 1000000,
          }),
          sendInvoice: jest.fn().mockResolvedValue({
            id: 'in_abc123',
            hosted_invoice_url: 'https://invoice.stripe.com/i/acct_xxx/test_xxx',
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

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

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: jest.fn().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: jest.fn().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 0, // Zero amount - should fail
            currency: 'usd',
          }),
        },
        customers: {
          list: jest.fn().mockResolvedValue({ data: [] }),
          create: jest.fn().mockResolvedValue({
            id: 'cus_new123',
            email: 'test@example.com',
          }),
          update: jest.fn().mockResolvedValue({ id: 'cus_new123' }),
        },
        subscriptions: {
          create: jest.fn(),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).toBeNull();
      // Subscription should not have been created because price validation happens first
      expect(mockStripeInstance.subscriptions.create).not.toHaveBeenCalled();
    });

    test('cancels subscription when invoice has zero amount', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: jest.fn().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: jest.fn().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000, // Valid price
            currency: 'usd',
          }),
        },
        customers: {
          list: jest.fn().mockResolvedValue({ data: [] }),
          create: jest.fn().mockResolvedValue({
            id: 'cus_new123',
            email: 'test@example.com',
          }),
          update: jest.fn().mockResolvedValue({ id: 'cus_new123' }),
        },
        subscriptions: {
          create: jest.fn().mockResolvedValue({
            id: 'sub_xyz789',
            latest_invoice: 'in_abc123',
          }),
          cancel: jest.fn().mockResolvedValue({ id: 'sub_xyz789' }),
        },
        invoices: {
          retrieve: jest.fn().mockResolvedValue({
            id: 'in_abc123',
            amount_due: 0, // Zero amount invoice - should cancel subscription
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).toBeNull();
      // Subscription should have been cancelled
      expect(mockStripeInstance.subscriptions.cancel).toHaveBeenCalledWith('sub_xyz789');
    });

    test('returns null when lookup key not found', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: jest.fn().mockResolvedValue({
            data: [], // No prices found
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice({
        ...validInvoiceData,
        lookupKey: 'invalid_lookup_key',
      });

      expect(result).toBeNull();
    });

    test('uses existing customer when found by email', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: jest.fn().mockResolvedValue({
            data: [{ id: 'price_abc123' }],
          }),
          retrieve: jest.fn().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000,
            currency: 'usd',
          }),
        },
        customers: {
          list: jest.fn().mockResolvedValue({
            data: [{ id: 'cus_existing123', email: 'ruben.schreurs@ebiquity.com' }],
          }),
          update: jest.fn().mockResolvedValue({
            id: 'cus_existing123',
            email: 'ruben.schreurs@ebiquity.com',
          }),
          create: jest.fn(),
        },
        subscriptions: {
          create: jest.fn().mockResolvedValue({
            id: 'sub_xyz789',
            latest_invoice: 'in_abc123',
          }),
        },
        invoices: {
          retrieve: jest.fn().mockResolvedValue({
            id: 'in_abc123',
            amount_due: 1000000,
          }),
          sendInvoice: jest.fn().mockResolvedValue({
            id: 'in_abc123',
            hosted_invoice_url: 'https://invoice.stripe.com/i/acct_xxx/test_xxx',
          }),
        },
      };
      StripeMock.mockImplementation(() => mockStripeInstance as any);

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice(validInvoiceData);

      expect(result).not.toBeNull();
      // Should update existing customer, not create new
      expect(mockStripeInstance.customers.update).toHaveBeenCalledWith('cus_existing123', expect.any(Object));
      expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
    });
  });
});
