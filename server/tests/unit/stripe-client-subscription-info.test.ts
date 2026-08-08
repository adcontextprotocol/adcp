import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

const retrieveCustomer = vi.fn();
const retrieveSubscription = vi.fn();
const retrieveProduct = vi.fn();

vi.mock('stripe', () => {
  class MockStripe {
    static API_VERSION = '2025-02-24.acacia';

    customers = {
      retrieve: retrieveCustomer,
    };

    subscriptions = {
      retrieve: retrieveSubscription,
    };

    products = {
      retrieve: retrieveProduct,
    };
  }

  return { default: MockStripe };
});

process.env.STRIPE_SECRET_KEY = 'sk_test_subscription_info';

const { getStripeSubscriptionInfo } = await import('../../src/billing/stripe-client.js');

function subscriptionFixture(
  id: string,
  lookupKey: string | null,
  product: string | Stripe.Product,
): Stripe.Subscription {
  return {
    id,
    status: 'active',
    items: {
      data: [
        {
          price: {
            lookup_key: lookupKey,
            product,
            unit_amount: 100000,
          },
        },
      ],
    },
  } as Stripe.Subscription;
}

describe('getStripeSubscriptionInfo', () => {
  beforeEach(() => {
    retrieveCustomer.mockReset();
    retrieveSubscription.mockReset();
    retrieveProduct.mockReset();
  });

  it('selects the membership subscription instead of the first stacked non-membership sub', async () => {
    const nonMembership = subscriptionFixture('sub_event', 'aao_event_ticket_2026', 'prod_event');
    const membership = subscriptionFixture('sub_member', 'aao_membership_builder_3000', 'prod_member');

    retrieveCustomer.mockResolvedValue({
      id: 'cus_x',
      deleted: false,
      subscriptions: {
        data: [nonMembership, membership],
      },
    });
    retrieveSubscription.mockResolvedValue({
      ...membership,
      latest_invoice: {
        id: 'in_x',
        period_start: 100,
        period_end: 200,
      },
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: {
              lookup_key: 'aao_membership_builder_3000',
              product: {
                id: 'prod_member',
                name: 'Builder Membership',
              },
              unit_amount: 300000,
              recurring: { interval: 'year', interval_count: 1 },
            },
          },
        ],
      },
    });

    const result = await getStripeSubscriptionInfo('cus_x');

    expect(result).toMatchObject({
      status: 'active',
      product_id: 'prod_member',
      product_name: 'Builder Membership',
      lookup_key: 'aao_membership_builder_3000',
      amount_cents: 300000,
      current_period_end: 200,
      cancel_at_period_end: false,
    });
    expect(retrieveSubscription).toHaveBeenCalledWith('sub_member', {
      expand: ['items.data.price.product', 'latest_invoice'],
    });
  });

  it('uses product metadata fallback for legacy membership subscriptions without membership lookup keys', async () => {
    const legacyMembership = subscriptionFixture('sub_founding', null, 'prod_founding');

    retrieveCustomer.mockResolvedValue({
      id: 'cus_x',
      deleted: false,
      subscriptions: {
        data: [legacyMembership],
      },
    });
    retrieveProduct.mockResolvedValue({
      id: 'prod_founding',
      deleted: false,
      metadata: { category: 'membership' },
    });
    retrieveSubscription.mockResolvedValue({
      ...legacyMembership,
      latest_invoice: null,
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: {
              lookup_key: null,
              product: {
                id: 'prod_founding',
                name: 'Founding Membership',
              },
              unit_amount: 1000000,
            },
          },
        ],
      },
    });

    const result = await getStripeSubscriptionInfo('cus_x');

    expect(result).toMatchObject({
      status: 'active',
      product_id: 'prod_founding',
      product_name: 'Founding Membership',
      amount_cents: 1000000,
    });
    expect(retrieveProduct).toHaveBeenCalledWith('prod_founding');
    expect(retrieveSubscription).toHaveBeenCalledWith('sub_founding', {
      expand: ['items.data.price.product', 'latest_invoice'],
    });
  });

  it('returns none when the customer only has non-membership subscriptions', async () => {
    retrieveCustomer.mockResolvedValue({
      id: 'cus_x',
      deleted: false,
      subscriptions: {
        data: [subscriptionFixture('sub_event', 'aao_event_ticket_2026', 'prod_event')],
      },
    });

    const result = await getStripeSubscriptionInfo('cus_x');

    expect(result).toEqual({ status: 'none' });
    expect(retrieveSubscription).not.toHaveBeenCalled();
  });
});
