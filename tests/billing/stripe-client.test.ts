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

  describe('getSubscriptionInfo', () => {
    test('returns null when Stripe is not initialized', async () => {
      // Set environment variable to undefined to disable Stripe
      const originalEnv = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;

      // Re-import module after changing env var
      const { getSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getSubscriptionInfo('cus_test123');

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
      const { getSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getSubscriptionInfo('cus_deleted');

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

      const { getSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getSubscriptionInfo('cus_nosubs');

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

      const { getSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getSubscriptionInfo('cus_active');

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

      const { getSubscriptionInfo } = await import('../../server/src/billing/stripe-client.js');

      const result = await getSubscriptionInfo('cus_error');

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

    test('creates customer and returns customer ID', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
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
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Test User',
        metadata: { org_id: 'org_123' },
      });
    });

    test('handles errors and returns null', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

      const StripeMock = (await import('stripe')).default as unknown as jest.MockedClass<typeof Stripe>;
      const mockStripeInstance = {
        customers: {
          create: jest.fn().mockRejectedValue(new Error('Stripe API error')),
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
});
