import Stripe from 'stripe';

// Initialize Stripe client
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  console.warn('STRIPE_SECRET_KEY not set - billing features will be disabled');
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
    console.warn('Stripe not initialized - cannot fetch subscription info');
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

    // Get the first subscription and expand it fully to get product details
    const subscriptionId = subscriptions.data[0].id;
    const subscriptionResponse = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product'],
    });
    // Type assertion: Stripe SDK returns Subscription object, not Response<Subscription>
    const subscription = subscriptionResponse as unknown as Stripe.Subscription;

    const product = subscription.items.data[0]?.price?.product;

    // Check if product is an object (not string or deleted) and has name property
    const productName =
      typeof product === 'object' && product && 'name' in product
        ? product.name
        : undefined;

    return {
      status: subscription.status as 'active' | 'past_due' | 'canceled' | 'unpaid',
      product_id: typeof product === 'string' ? product : product?.id,
      product_name: productName,
      current_period_end: (subscription as any).current_period_end ?? undefined,
      cancel_at_period_end: (subscription as any).cancel_at_period_end ?? undefined,
    };
  } catch (error) {
    console.error('Error fetching subscription from Stripe:', error);
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
    console.warn('Stripe not initialized - cannot create customer');
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
    console.error('Error creating Stripe customer:', error);
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
    console.warn('Stripe not initialized - cannot create portal session');
    return null;
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });

    return session.url;
  } catch (error) {
    console.error('Error creating Customer Portal session:', error);
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
    console.warn('Stripe not initialized - cannot create customer session');
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
    console.error('Error creating customer session:', error);
    return null;
  }
}
