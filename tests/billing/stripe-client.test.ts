// lint-allow-test-imports-file: this suite legitimately tests
// `STRIPE_SECRET_KEY`-loaded module init — vi.resetModules() and dynamic
// imports per test are how the env-var-load behavior is exercised.
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
    vi.doUnmock('../../server/src/db/client.js');
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

    test('re-throws resource_missing so callers can recover from a stale ID', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const notFound = Object.assign(new Error('No such customer'), {
        code: 'resource_missing',
        statusCode: 404,
      });
      const mockStripeInstance = {
        customerSessions: {
          create: vi.fn<any>().mockRejectedValue(notFound),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCustomerSession } = await import('../../server/src/billing/stripe-client.js');

      await expect(createCustomerSession('cus_stale')).rejects.toMatchObject({
        code: 'resource_missing',
      });
    });

    test('returns null and swallows other Stripe errors', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customerSessions: {
          create: vi.fn<any>().mockRejectedValue(new Error('boom')),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCustomerSession } = await import('../../server/src/billing/stripe-client.js');

      const result = await createCustomerSession('cus_123');
      expect(result).toBeNull();
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

      // Verify subscription was created with correct parameters.
      // createAndSendInvoice now passes a second argument (Stripe RequestOptions)
      // when an idempotency key is supplied — undefined here since this test
      // doesn't exercise that path.
      expect(mockStripeInstance.subscriptions.create).toHaveBeenCalledWith(
        {
          customer: 'cus_new123',
          items: [{ price: 'price_abc123' }],
          collection_method: 'send_invoice',
          days_until_due: 30,
          metadata: expect.objectContaining({
            lookup_key: 'aao_membership_corporate_5m',
            contact_name: 'Ruben Schreurs',
          }),
        },
        undefined,
      );
    });

    test('stamps invoice subscriptions with org and user metadata for webhook agreement attribution', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
      const mockDbQuery = vi.fn<any>().mockResolvedValue({ rows: [] });
      vi.doMock('../../server/src/db/client.js', () => ({
        getPool: () => ({ query: mockDbQuery }),
      }));

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>().mockResolvedValue({ data: [{ id: 'price_abc123' }] }),
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000,
            currency: 'usd',
          }),
        },
        customers: {
          search: vi.fn<any>().mockResolvedValue({ data: [] }),
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

      const result = await createAndSendInvoice({
        ...validInvoiceData,
        workosOrganizationId: 'org_123',
        workosUserId: 'user_123',
      });

      expect(result).not.toBeNull();
      expect(mockDbQuery).toHaveBeenCalledWith(
        'SELECT stripe_customer_id FROM organizations WHERE workos_organization_id = $1',
        ['org_123'],
      );
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          workos_organization_id: 'org_123',
          workos_user_id: 'user_123',
        }),
      }));
      expect(mockStripeInstance.subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            workos_organization_id: 'org_123',
            workos_user_id: 'user_123',
          }),
        }),
        undefined,
      );
    });

    test('refuses org-scoped invoice creation without signer metadata', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>(),
        },
        subscriptions: {
          create: vi.fn<any>(),
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createAndSendInvoice } = await import('../../server/src/billing/stripe-client.js');

      const result = await createAndSendInvoice({
        ...validInvoiceData,
        workosOrganizationId: 'org_123',
      });

      expect(result).toBeNull();
      expect(mockStripeInstance.prices.list).not.toHaveBeenCalled();
      expect(mockStripeInstance.subscriptions.create).not.toHaveBeenCalled();
    });

    test('stamps metadata when reusing a DB-linked Stripe customer', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
      const mockDbQuery = vi.fn<any>().mockResolvedValue({
        rows: [{ stripe_customer_id: 'cus_linked' }],
      });
      vi.doMock('../../server/src/db/client.js', () => ({
        getPool: () => ({ query: mockDbQuery }),
      }));

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          list: vi.fn<any>().mockResolvedValue({ data: [{ id: 'price_abc123' }] }),
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_abc123',
            unit_amount: 1000000,
            currency: 'usd',
          }),
        },
        customers: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'cus_linked',
            name: 'Linked Customer',
            metadata: { workos_organization_id: 'org_123', existing: 'yes' },
          }),
          update: vi.fn<any>().mockResolvedValue({
            id: 'cus_linked',
            email: 'billing@example.com',
          }),
          create: vi.fn<any>(),
          search: vi.fn<any>(),
          list: vi.fn<any>(),
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

      const result = await createAndSendInvoice({
        ...validInvoiceData,
        workosOrganizationId: 'org_123',
        workosUserId: 'user_123',
      });

      expect(result).not.toBeNull();
      expect(mockStripeInstance.customers.retrieve).toHaveBeenCalledWith('cus_linked');
      expect(mockStripeInstance.customers.update).toHaveBeenNthCalledWith(1, 'cus_linked', {
        metadata: expect.objectContaining({
          existing: 'yes',
          workos_organization_id: 'org_123',
          workos_user_id: 'user_123',
        }),
      });
      expect(mockStripeInstance.customers.update).toHaveBeenNthCalledWith(2, 'cus_linked', {
        address: validInvoiceData.billingAddress,
      });
      expect(mockStripeInstance.subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_linked',
          metadata: expect.objectContaining({
            workos_organization_id: 'org_123',
            workos_user_id: 'user_123',
          }),
        }),
        undefined,
      );
      expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
      expect(mockStripeInstance.customers.search).not.toHaveBeenCalled();
      expect(mockStripeInstance.customers.list).not.toHaveBeenCalled();
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
    test('includes subscription_data.metadata with org and user IDs for subscription-mode checkout', async () => {
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
      expect(createCall.subscription_data.metadata.workos_user_id).toBe('user_test_456');
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

    test('adds autopublish disclosure for membership-tier prices', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_membership',
            recurring: { interval: 'year' },
            lookup_key: 'aao_membership_professional_250',
          }),
        },
        checkout: {
          sessions: {
            create: vi.fn<any>().mockResolvedValue({ id: 'cs_mem', url: 'https://checkout.stripe.com/mem' }),
          },
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');

      await createCheckoutSession({
        priceId: 'price_membership',
        customerEmail: 'test@example.com',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
        workosOrganizationId: 'org_test_123',
      });

      const createCall = mockStripeInstance.checkout.sessions.create.mock.calls[0][0] as any;
      expect(createCall.custom_text?.submit?.message).toBeDefined();
      expect(createCall.custom_text.submit.message).toMatch(/publishes your organization/i);
      expect(createCall.custom_text.submit.message).toMatch(/member directory/i);
    });

    test('adds disclosure for invoice-based membership prices', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_invoice_mem',
            recurring: null,
            lookup_key: 'aao_invoice_corporate_5m',
          }),
        },
        checkout: {
          sessions: {
            create: vi.fn<any>().mockResolvedValue({ id: 'cs_inv', url: 'https://checkout.stripe.com/inv' }),
          },
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');

      await createCheckoutSession({
        priceId: 'price_invoice_mem',
        customerEmail: 'test@example.com',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      const createCall = mockStripeInstance.checkout.sessions.create.mock.calls[0][0] as any;
      expect(createCall.custom_text?.submit?.message).toMatch(/directory/i);
    });

    test('omits disclosure for non-membership prices (e.g. event sponsorships)', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_sponsorship',
            recurring: null,
            lookup_key: 'event_sponsorship_gold',
          }),
        },
        checkout: {
          sessions: {
            create: vi.fn<any>().mockResolvedValue({ id: 'cs_spons', url: 'https://checkout.stripe.com/spons' }),
          },
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');

      await createCheckoutSession({
        priceId: 'price_sponsorship',
        customerEmail: 'test@example.com',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      const createCall = mockStripeInstance.checkout.sessions.create.mock.calls[0][0] as any;
      expect(createCall.custom_text).toBeUndefined();
    });

    test('omits disclosure when price has no lookup_key', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        prices: {
          retrieve: vi.fn<any>().mockResolvedValue({
            id: 'price_unlabeled',
            recurring: { interval: 'year' },
            lookup_key: null,
          }),
        },
        checkout: {
          sessions: {
            create: vi.fn<any>().mockResolvedValue({ id: 'cs_ul', url: 'https://checkout.stripe.com/ul' }),
          },
        },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { createCheckoutSession } = await import('../../server/src/billing/stripe-client.js');

      await createCheckoutSession({
        priceId: 'price_unlabeled',
        customerEmail: 'test@example.com',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      const createCall = mockStripeInstance.checkout.sessions.create.mock.calls[0][0] as any;
      expect(createCall.custom_text).toBeUndefined();
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

  describe('getAllOpenInvoices', () => {
    test('does not exceed Stripe 4-level expand cap (data.lines.data.price.product is 5)', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const listMock = vi.fn<any>().mockImplementation(({ expand }: { expand?: string[] }) => {
        for (const path of expand || []) {
          // Stripe rejects expand paths deeper than 4 levels.
          if (path.split('.').length > 4) {
            const err = new Error(
              `You cannot expand more than 4 levels of a property. Property: ${path}`,
            );
            return Promise.reject(err);
          }
        }
        return {
          [Symbol.asyncIterator]: async function* () {
            // empty
          },
        };
      });
      const mockStripeInstance = {
        invoices: { list: listMock },
        products: { retrieve: vi.fn() },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getAllOpenInvoices } = await import('../../server/src/billing/stripe-client.js');

      // No expand path the function actually sends should exceed 4 levels —
      // i.e. the function must complete without the stub's >4-level rejection
      // firing. If a regression reintroduces `data.lines.data.price.product`,
      // listMock rejects and getAllOpenInvoices propagates the throw.
      await expect(getAllOpenInvoices(50)).resolves.toEqual([]);
      const allExpands = listMock.mock.calls.flatMap(
        (call) => (call[0] as { expand?: string[] }).expand || [],
      );
      expect(allExpands.length).toBeGreaterThan(0);
      for (const path of allExpands) {
        expect(path.split('.').length).toBeLessThanOrEqual(4);
      }
    });

    test('propagates Stripe errors to the caller (no silent empty-array fallback)', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      // Stripe SDK throws synchronously here to model how the previous swallow
      // turned a real 400 into "No pending invoices found" for the admin UI.
      const listMock = vi.fn<any>().mockImplementation(() => {
        throw new Error('You cannot expand more than 4 levels of a property. Property: data.lines.data.price.product');
      });
      const mockStripeInstance = {
        invoices: { list: listMock },
        products: { retrieve: vi.fn() },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getAllOpenInvoices } = await import('../../server/src/billing/stripe-client.js');

      await expect(getAllOpenInvoices(50)).rejects.toThrow(/4 levels/);
    });

    test('resolves product names via separate stripe.products.retrieve, with caching', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;

      const makeInvoice = (id: string, productId: string) => ({
        id,
        status: 'open',
        amount_due: 10000,
        currency: 'usd',
        created: 1700000000,
        due_date: null,
        hosted_invoice_url: null,
        customer: { id: 'cus_1', name: 'Acme', email: 'a@example.com', metadata: {} },
        lines: {
          data: [{ price: { id: 'price_1', product: productId } }],
        },
      });

      const productRetrieve = vi.fn<any>().mockImplementation((id: string) =>
        Promise.resolve({ id, name: `Product ${id}` }),
      );

      const mockStripeInstance = {
        invoices: {
          list: vi.fn<any>().mockImplementation(({ status }: { status: string }) => {
            const invoices = status === 'open'
              ? [makeInvoice('in_1', 'prod_A'), makeInvoice('in_2', 'prod_A')]
              : [];
            return {
              [Symbol.asyncIterator]: async function* () {
                for (const inv of invoices) yield inv;
              },
            };
          }),
        },
        products: { retrieve: productRetrieve },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getAllOpenInvoices } = await import('../../server/src/billing/stripe-client.js');

      const result = await getAllOpenInvoices(50);

      expect(result).toHaveLength(2);
      expect(result[0].product_name).toBe('Product prod_A');
      expect(result[1].product_name).toBe('Product prod_A');
      // Cached: only fetched once even though referenced twice.
      expect(productRetrieve).toHaveBeenCalledTimes(1);
      expect(productRetrieve).toHaveBeenCalledWith('prod_A');
    });
  });

  describe('getPendingInvoices', () => {
    // Issue #4564: abandoned subscription attempts leave $0 / no-line-item drafts
    // on the Stripe customer. Surfacing them as "pending invoice" confuses members
    // (Rishi @ InMobi, 2026-05-14). Filter them out, but keep real drafts (with
    // line items + amount) and all `open` invoices.
    test('drops empty draft invoices (no line items or zero amount)', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const listMock = vi.fn<any>().mockImplementation(({ status }: { status: string }) => {
        if (status === 'open') return { data: [] };
        return {
          data: [
            // Empty draft — no line items. Must be filtered out.
            {
              id: 'in_empty',
              status: 'draft',
              amount_due: 0,
              currency: 'usd',
              created: 1700000000,
              due_date: null,
              hosted_invoice_url: null,
              customer_email: 'r@example.com',
              lines: { data: [] },
            },
            // Real draft — has product + amount. Must survive.
            {
              id: 'in_real',
              status: 'draft',
              amount_due: 5000000,
              currency: 'usd',
              created: 1700000000,
              due_date: null,
              hosted_invoice_url: null,
              customer_email: 'r@example.com',
              lines: { data: [{ price: { product: { name: 'Leader' } } }] },
            },
          ],
        };
      });
      const mockStripeInstance = {
        invoices: { list: listMock },
        products: { retrieve: vi.fn() },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getPendingInvoices } = await import('../../server/src/billing/stripe-client.js');
      const result = await getPendingInvoices('cus_x');

      expect(result.map(r => r.id)).toEqual(['in_real']);
    });

    test('drops a draft that has a non-zero amount_due but no line items', async () => {
      // Locks down the AND semantics of the filter: both conditions must
      // hold. A draft with amount but no lines is still not actionable —
      // there's nothing for Stripe to invoice — and should not surface.
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const listMock = vi.fn<any>().mockImplementation(({ status }: { status: string }) => {
        if (status === 'open') return { data: [] };
        return {
          data: [{
            id: 'in_phantom_amount',
            status: 'draft',
            amount_due: 1000,
            currency: 'usd',
            created: 1700000000,
            due_date: null,
            hosted_invoice_url: null,
            customer_email: 'r@example.com',
            lines: { data: [] },
          }],
        };
      });
      const mockStripeInstance = {
        invoices: { list: listMock },
        products: { retrieve: vi.fn() },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getPendingInvoices } = await import('../../server/src/billing/stripe-client.js');
      const result = await getPendingInvoices('cus_x');

      expect(result).toEqual([]);
    });

    test('keeps open invoices regardless of amount/line state', async () => {
      // Stripe `open` invoices have already been finalized + sent. Even an
      // edge-case open invoice with a $0 balance (e.g. fully refunded) is
      // legitimate state that the UI needs to render.
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as MockedClass<typeof Stripe>;
      const listMock = vi.fn<any>().mockImplementation(({ status }: { status: string }) => {
        if (status === 'open') {
          return {
            data: [{
              id: 'in_open',
              status: 'open',
              amount_due: 0,
              currency: 'usd',
              created: 1700000000,
              due_date: null,
              hosted_invoice_url: 'https://invoice.example/x',
              customer_email: 'r@example.com',
              lines: { data: [] },
            }],
          };
        }
        return { data: [] };
      });
      const mockStripeInstance = {
        invoices: { list: listMock },
        products: { retrieve: vi.fn() },
      };
      StripeMock.mockImplementation(function () { return mockStripeInstance as any; });

      const { getPendingInvoices } = await import('../../server/src/billing/stripe-client.js');
      const result = await getPendingInvoices('cus_x');

      expect(result.map(r => r.id)).toEqual(['in_open']);
    });
  });

  describe('buildOrgCouponName', () => {
    test('keeps short org names intact', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      expect(buildOrgCouponName('Acme Inc', '$500.00 off'))
        .toBe('Acme Inc - $500.00 off');
    });

    test('truncates long org names so total stays at most 40 chars', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      // Real-world repro: a long org name plus " - $500.00 off" overflowed Stripe's 40-char cap
      const result = buildOrgCouponName(
        'The Omnichannel Network Exchange  O-N-X',
        '$500.00 off',
      );
      expect(result.length).toBeLessThanOrEqual(40);
      expect(result.endsWith(' - $500.00 off')).toBe(true);
    });

    test('collapses internal whitespace runs in the org name', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      expect(buildOrgCouponName('Acme    \t  Inc', '10% off'))
        .toBe('Acme Inc - 10% off');
    });

    test('handles a percent discount description', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      const result = buildOrgCouponName('Some Very Long Company Name LLC International', '25% off');
      expect(result.length).toBeLessThanOrEqual(40);
      expect(result.endsWith(' - 25% off')).toBe(true);
    });

    test('falls back to discount description alone when org name is empty', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      expect(buildOrgCouponName('', '$500.00 off'))
        .toBe('$500.00 off');
    });

    test('treats whitespace-only org names as empty', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      expect(buildOrgCouponName('   \t\n', '10% off'))
        .toBe('10% off');
    });

    test('strips bidi and zero-width format characters', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      // U+202E (RTL override) and U+200B (zero-width space) must not survive
      const result = buildOrgCouponName('Acme‮​ Inc', '$500.00 off');
      expect(result).toBe('Acme Inc - $500.00 off');
      expect(/[‪-‮​-‍]/.test(result)).toBe(false);
    });

    test('slices by code points so emoji and CJK names are not split mid-surrogate', async () => {
      const { buildOrgCouponName } = await import('../../server/src/billing/stripe-client.js');
      // Each "🚀" is a UTF-16 surrogate pair; a string-byte slice could halve one.
      const orgName = '🚀'.repeat(20);
      const result = buildOrgCouponName(orgName, '$500.00 off');
      expect(result.length).toBeLessThanOrEqual(40);
      // Re-encoding the result must round-trip — no lone surrogates.
      expect(result).toBe(result.normalize('NFC'));
      expect(result.endsWith(' - $500.00 off')).toBe(true);
    });
  });
});
