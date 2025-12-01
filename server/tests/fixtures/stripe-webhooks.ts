/**
 * Stripe webhook event fixtures for testing
 * Based on actual Stripe webhook payload structures
 */

import type Stripe from 'stripe';

export const createInvoicePaymentSucceededEvent = (overrides: {
  customerId?: string;
  subscriptionId?: string;
  amount?: number;
  productName?: string;
  priceId?: string;
  interval?: 'month' | 'year';
} = {}): Stripe.Event => {
  const timestamp = Math.floor(Date.now() / 1000);

  return {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    api_version: '2023-10-16',
    created: timestamp,
    type: 'invoice.payment_succeeded',
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: `in_test_${Date.now()}`,
        object: 'invoice',
        amount_paid: overrides.amount || 2999, // $29.99 in cents
        amount_due: overrides.amount || 2999,
        attempt_count: 1,
        attempted: true,
        billing_reason: 'subscription_create',
        charge: `ch_test_${Date.now()}`,
        currency: 'usd',
        customer: overrides.customerId || `cus_test_${Date.now()}`,
        payment_intent: `pi_test_${Date.now()}`,
        subscription: overrides.subscriptionId || `sub_test_${Date.now()}`,
        status: 'paid',
        status_transitions: {
          finalized_at: timestamp - 10,
          paid_at: timestamp,
          marked_uncollectible_at: null,
          voided_at: null,
        },
        period_start: timestamp,
        period_end: timestamp + (30 * 24 * 60 * 60), // 30 days
        number: `INV-${Date.now()}`,
        hosted_invoice_url: `https://invoice.stripe.com/i/test_${Date.now()}`,
        invoice_pdf: `https://invoice.stripe.com/i/test_${Date.now()}/pdf`,
        metadata: {},
        lines: {
          object: 'list',
          data: [
            {
              id: `il_test_${Date.now()}`,
              object: 'line_item',
              amount: overrides.amount || 2999,
              currency: 'usd',
              description: overrides.productName || 'Professional Plan',
              type: 'subscription',
              subscription: overrides.subscriptionId || `sub_test_${Date.now()}`,
              subscription_item: `si_test_${Date.now()}`,
              quantity: 1,
              price: {
                id: overrides.priceId || `price_test_${Date.now()}`,
                object: 'price',
                active: true,
                currency: 'usd',
                product: `prod_test_${Date.now()}`,
                type: 'recurring',
                unit_amount: overrides.amount || 2999,
                recurring: {
                  interval: overrides.interval || 'month',
                  interval_count: 1,
                  usage_type: 'licensed',
                },
              },
              metadata: {},
            } as any,
          ],
          has_more: false,
          url: '/v1/invoices/test/lines',
        },
      } as Stripe.Invoice,
    },
  } as Stripe.Event;
};

export const createInvoicePaymentFailedEvent = (overrides: {
  customerId?: string;
  subscriptionId?: string;
  attemptCount?: number;
} = {}): Stripe.Event => {
  const timestamp = Math.floor(Date.now() / 1000);

  return {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    api_version: '2023-10-16',
    created: timestamp,
    type: 'invoice.payment_failed',
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: `in_test_${Date.now()}`,
        object: 'invoice',
        amount_paid: 0,
        amount_due: 2999,
        attempt_count: overrides.attemptCount || 1,
        attempted: true,
        billing_reason: 'subscription_cycle',
        charge: null,
        currency: 'usd',
        customer: overrides.customerId || `cus_test_${Date.now()}`,
        payment_intent: `pi_test_${Date.now()}`,
        subscription: overrides.subscriptionId || `sub_test_${Date.now()}`,
        status: 'open',
        status_transitions: {
          finalized_at: timestamp - 10,
          paid_at: null,
          marked_uncollectible_at: null,
          voided_at: null,
        },
        period_start: timestamp - (30 * 24 * 60 * 60),
        period_end: timestamp,
        next_payment_attempt: timestamp + (24 * 60 * 60),
        last_finalization_error: {
          code: 'card_declined',
          message: 'Your card was declined',
        },
        metadata: {},
        lines: {
          object: 'list',
          data: [],
          has_more: false,
          url: '/v1/invoices/test/lines',
        },
      } as Stripe.Invoice,
    },
  } as Stripe.Event;
};

export const createChargeRefundedEvent = (overrides: {
  customerId?: string;
  amount?: number;
  refundedAmount?: number;
  refundReason?: string;
} = {}): Stripe.Event => {
  const timestamp = Math.floor(Date.now() / 1000);
  const amount = overrides.amount || 2999;
  const refundedAmount = overrides.refundedAmount || amount;

  return {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    api_version: '2023-10-16',
    created: timestamp,
    type: 'charge.refunded',
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: `ch_test_${Date.now()}`,
        object: 'charge',
        amount,
        amount_refunded: refundedAmount,
        currency: 'usd',
        customer: overrides.customerId || `cus_test_${Date.now()}`,
        payment_intent: `pi_test_${Date.now()}`,
        refunded: refundedAmount === amount,
        status: 'succeeded',
        metadata: {},
        refunds: {
          object: 'list',
          data: [
            {
              id: `re_test_${Date.now()}`,
              object: 'refund',
              amount: refundedAmount,
              currency: 'usd',
              charge: `ch_test_${Date.now()}`,
              reason: overrides.refundReason || 'requested_by_customer',
              status: 'succeeded',
              created: timestamp,
            } as any,
          ],
          has_more: false,
          url: '/v1/charges/test/refunds',
        },
      } as Stripe.Charge,
    },
  } as Stripe.Event;
};

export const createSubscriptionCreatedEvent = (overrides: {
  customerId?: string;
  subscriptionId?: string;
  status?: string;
  productName?: string;
} = {}): Stripe.Event => {
  const timestamp = Math.floor(Date.now() / 1000);

  return {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    api_version: '2023-10-16',
    created: timestamp,
    type: 'customer.subscription.created',
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: overrides.subscriptionId || `sub_test_${Date.now()}`,
        object: 'subscription',
        customer: overrides.customerId || `cus_test_${Date.now()}`,
        status: overrides.status || 'active',
        current_period_start: timestamp,
        current_period_end: timestamp + (30 * 24 * 60 * 60),
        items: {
          object: 'list',
          data: [
            {
              id: `si_test_${Date.now()}`,
              object: 'subscription_item',
              price: {
                id: `price_test_${Date.now()}`,
                product: `prod_test_${Date.now()}`,
                unit_amount: 2999,
                recurring: {
                  interval: 'month',
                },
              },
            } as any,
          ],
        },
        metadata: {},
      } as Stripe.Subscription,
    },
  } as Stripe.Event;
};
