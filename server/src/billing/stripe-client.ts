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

    // Add explicit null checks for invoice structure
    if (!latestInvoice) {
      logger.warn({
        subscriptionId: subscription.id,
        customerId: stripeCustomerId,
      }, 'No latest_invoice on subscription - period_end calculation may be inaccurate');
    }

    let periodEnd = typeof latestInvoice === 'object' && latestInvoice ? latestInvoice.period_end : undefined;
    const periodStart = typeof latestInvoice === 'object' && latestInvoice ? latestInvoice.period_start : undefined;

    // Warn if expected fields are missing
    if (latestInvoice && typeof latestInvoice === 'object' && !periodEnd) {
      logger.warn({
        subscriptionId: subscription.id,
        customerId: stripeCustomerId,
        invoiceId: latestInvoice.id,
      }, 'Latest invoice missing period_end field - renewal date will be unavailable');
    }

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

export interface RevenueEvent {
  workos_organization_id: string;
  stripe_invoice_id: string;
  stripe_subscription_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  amount_paid: number;
  currency: string;
  revenue_type: string;
  billing_reason: string | null;
  product_id: string | null;
  product_name: string | null;
  price_id: string | null;
  billing_interval: string | null;
  paid_at: Date;
  period_start: Date | null;
  period_end: Date | null;
}

/**
 * Fetch all paid invoices from Stripe and return revenue events
 * Used for backfilling historical revenue data
 */
export async function fetchAllPaidInvoices(
  customerOrgMap: Map<string, string>
): Promise<RevenueEvent[]> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot fetch invoices');
    return [];
  }

  const events: RevenueEvent[] = [];
  // Cache product info to avoid N+1 API calls
  const productCache = new Map<string, { id: string; name: string }>();

  try {
    // Fetch all paid invoices
    for await (const invoice of stripe.invoices.list({
      status: 'paid',
      limit: 100,
      expand: ['data.subscription', 'data.charge'],
    })) {
      const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;

      if (!customerId) {
        continue;
      }

      const workosOrgId = customerOrgMap.get(customerId);
      if (!workosOrgId) {
        logger.debug({ customerId, invoiceId: invoice.id }, 'No org mapping for customer');
        continue;
      }

      // Get the primary line item for product info
      const primaryLine = invoice.lines?.data[0];
      let productId: string | null = null;
      let productName: string | null = null;
      let priceId: string | null = null;
      let billingInterval: string | null = null;

      if (primaryLine) {
        const price = primaryLine.price;
        if (price) {
          priceId = price.id;
          billingInterval = price.recurring?.interval || null;
          const product = price.product;
          if (typeof product === 'string') {
            productId = product;
            // Check cache first to avoid N+1 API calls
            let cachedProduct = productCache.get(product);
            if (!cachedProduct) {
              // Try to fetch product name and cache it
              try {
                const productObj = await stripe.products.retrieve(product);
                cachedProduct = { id: productObj.id, name: productObj.name };
                productCache.set(product, cachedProduct);
              } catch {
                // Use description as fallback, don't cache failures
                // Leave cachedProduct as undefined to use fallback below
              }
            }
            productName = cachedProduct?.name || primaryLine.description || null;
          } else if (product && typeof product === 'object' && 'name' in product) {
            productId = product.id;
            productName = product.name;
            // Cache the expanded product object
            productCache.set(product.id, { id: product.id, name: product.name });
          }
        }
      }

      // Determine revenue type
      let revenueType = 'subscription_recurring';
      if (invoice.billing_reason === 'subscription_create') {
        revenueType = 'subscription_initial';
      } else if (!invoice.subscription) {
        revenueType = 'one_time';
      }

      const charge = typeof invoice.charge === 'object' ? invoice.charge : null;

      events.push({
        workos_organization_id: workosOrgId,
        stripe_invoice_id: invoice.id,
        stripe_subscription_id: typeof invoice.subscription === 'string'
          ? invoice.subscription
          : invoice.subscription?.id || null,
        stripe_payment_intent_id: typeof invoice.payment_intent === 'string'
          ? invoice.payment_intent
          : invoice.payment_intent?.id || null,
        stripe_charge_id: charge?.id || null,
        amount_paid: invoice.amount_paid,
        currency: invoice.currency,
        revenue_type: revenueType,
        billing_reason: invoice.billing_reason || null,
        product_id: productId,
        product_name: productName,
        price_id: priceId,
        billing_interval: billingInterval,
        paid_at: new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000),
        period_start: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
        period_end: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
      });
    }

    logger.info({ count: events.length }, 'Fetched paid invoices from Stripe');
    return events;
  } catch (error) {
    logger.error({ err: error }, 'Error fetching invoices from Stripe');
    throw error;
  }
}

/**
 * Fetch all refunds from Stripe and return revenue events
 */
export async function fetchAllRefunds(
  customerOrgMap: Map<string, string>
): Promise<RevenueEvent[]> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot fetch refunds');
    return [];
  }

  const events: RevenueEvent[] = [];

  try {
    for await (const refund of stripe.refunds.list({
      limit: 100,
      expand: ['data.charge'],
    })) {
      const charge = typeof refund.charge === 'object' ? refund.charge : null;
      if (!charge) continue;

      const customerId = typeof charge.customer === 'string'
        ? charge.customer
        : charge.customer?.id;

      if (!customerId) continue;

      const workosOrgId = customerOrgMap.get(customerId);
      if (!workosOrgId) continue;

      // Get invoice ID from charge metadata or use refund ID as fallback
      const chargeInvoice = (charge as Stripe.Charge & { invoice?: string | { id: string } | null }).invoice;
      const invoiceId = typeof chargeInvoice === 'string'
        ? chargeInvoice
        : chargeInvoice?.id || `refund_${refund.id}`;

      events.push({
        workos_organization_id: workosOrgId,
        stripe_invoice_id: invoiceId,
        stripe_subscription_id: null,
        stripe_payment_intent_id: typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id || null,
        stripe_charge_id: charge.id,
        amount_paid: -refund.amount, // Negative for refunds
        currency: refund.currency,
        revenue_type: 'refund',
        billing_reason: null,
        product_id: null,
        product_name: null,
        price_id: null,
        billing_interval: null,
        paid_at: new Date(refund.created * 1000),
        period_start: null,
        period_end: null,
      });
    }

    logger.info({ count: events.length }, 'Fetched refunds from Stripe');
    return events;
  } catch (error) {
    logger.error({ err: error }, 'Error fetching refunds from Stripe');
    throw error;
  }
}
