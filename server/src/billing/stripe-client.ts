import Stripe from 'stripe';
import { createLogger } from '../logger.js';

const logger = createLogger('stripe-client');

// Initialize Stripe client
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  logger.warn('STRIPE_SECRET_KEY not set - billing features will be disabled');
}

export const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: '2025-11-17.clover',
    })
  : null;

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * Get subscription info from Stripe for an organization
 */
export async function getSubscriptionInfo(
  stripeCustomerId: string
): Promise<{
  status: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'none';
  product_id?: string;
  product_name?: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
} | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot fetch subscription info');
    return null;
  }

  try {
    // First, get the customer with their subscriptions
    const customer = await stripe.customers.retrieve(stripeCustomerId, {
      expand: ['subscriptions'],
    });

    if (customer.deleted) {
      return { status: 'none' };
    }

    const subscriptions = (customer as Stripe.Customer).subscriptions;
    if (!subscriptions || subscriptions.data.length === 0) {
      return { status: 'none' };
    }

    // The subscription from customer.subscriptions is a limited object
    // We need to fetch the full subscription with latest_invoice expanded to get current_period_end
    const subscriptionId = subscriptions.data[0].id;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product', 'latest_invoice'],
    });

    logger.debug({
      billing_cycle_anchor: subscription.billing_cycle_anchor,
      created: subscription.created,
      start_date: subscription.start_date,
      trial_end: subscription.trial_end,
      trial_start: subscription.trial_start,
    }, 'Subscription details');

    // In newer Stripe API versions, current_period_end may be on the latest invoice
    const latestInvoice = subscription.latest_invoice as Stripe.Invoice | string | null;
    let periodEnd = typeof latestInvoice === 'object' && latestInvoice ? latestInvoice.period_end : undefined;
    const periodStart = typeof latestInvoice === 'object' && latestInvoice ? latestInvoice.period_start : undefined;

    logger.debug({ period_start: periodStart, period_end: periodEnd }, 'Latest invoice period');

    // If period_end equals period_start (zero-duration period), calculate from price interval
    if (periodEnd && periodStart && periodEnd === periodStart) {
      const price = subscription.items.data[0]?.price;
      if (price && typeof price === 'object') {
        const interval = price.recurring?.interval;
        const intervalCount = price.recurring?.interval_count || 1;

        logger.debug({ interval, interval_count: intervalCount }, 'Price interval details');

        // Calculate the actual renewal date based on billing interval
        const startDate = new Date(periodStart * 1000);
        if (interval === 'month') {
          startDate.setMonth(startDate.getMonth() + intervalCount);
        } else if (interval === 'year') {
          startDate.setFullYear(startDate.getFullYear() + intervalCount);
        } else if (interval === 'week') {
          startDate.setDate(startDate.getDate() + (7 * intervalCount));
        } else if (interval === 'day') {
          startDate.setDate(startDate.getDate() + intervalCount);
        }

        periodEnd = Math.floor(startDate.getTime() / 1000);
        logger.debug({ calculated_period_end: periodEnd }, 'Calculated period_end from interval');
      }
    }

    const product = subscription.items.data[0]?.price?.product;

    // Check if product is an object (not string or deleted) and has name property
    const productName =
      typeof product === 'object' && product && 'name' in product
        ? product.name
        : undefined;

    const result = {
      status: subscription.status as 'active' | 'past_due' | 'canceled' | 'unpaid',
      product_id: typeof product === 'string' ? product : product?.id,
      product_name: productName,
      current_period_end: periodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end,
    };

    logger.debug({ result }, 'Returning subscription info');
    return result;
  } catch (error) {
    logger.error({ err: error }, 'Error fetching subscription from Stripe');
    return null;
  }
}

/**
 * Create a Stripe customer for an organization
 */
export async function createStripeCustomer(data: {
  email: string;
  name: string;
  metadata?: Record<string, string>;
}): Promise<string | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create customer');
    return null;
  }

  try {
    const customer = await stripe.customers.create({
      email: data.email,
      name: data.name,
      metadata: data.metadata,
    });

    return customer.id;
  } catch (error) {
    logger.error({ err: error }, 'Error creating Stripe customer');
    return null;
  }
}

/**
 * Create a Customer Portal session for billing management
 */
export async function createCustomerPortalSession(
  stripeCustomerId: string,
  returnUrl: string
): Promise<string | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create portal session');
    return null;
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });

    return session.url;
  } catch (error) {
    logger.error({ err: error }, 'Error creating Customer Portal session');
    return null;
  }
}

/**
 * Create a customer session for the Stripe Pricing Table
 */
export async function createCustomerSession(
  stripeCustomerId: string
): Promise<string | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create customer session');
    return null;
  }

  try {
    const session = await stripe.customerSessions.create({
      customer: stripeCustomerId,
      components: {
        pricing_table: {
          enabled: true,
        },
      },
    });

    return session.client_secret;
  } catch (error) {
    logger.error({ err: error }, 'Error creating customer session');
    return null;
  }
}

/**
 * List all Stripe customers with their WorkOS organization IDs
 * Used for syncing Stripe data to local database on startup
 */
export async function listCustomersWithOrgIds(): Promise<
  Array<{ stripeCustomerId: string; workosOrgId: string }>
> {
  if (!stripe) {
    return [];
  }

  const results: Array<{ stripeCustomerId: string; workosOrgId: string }> = [];

  try {
    // Iterate through all customers (auto-pagination)
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      const workosOrgId = customer.metadata?.workos_organization_id;
      if (workosOrgId) {
        results.push({
          stripeCustomerId: customer.id,
          workosOrgId,
        });
      }
    }

    return results;
  } catch (error) {
    logger.error({ err: error }, 'Error listing Stripe customers');
    return [];
  }
}
