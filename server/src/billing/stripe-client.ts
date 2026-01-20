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

// Cache for products (refreshed periodically)
let productsCache: BillingProduct[] | null = null;
let productsCacheTime = 0;
const PRODUCTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface BillingProduct {
  lookup_key: string;
  price_id: string;
  product_id: string;
  product_name: string;
  display_name: string;
  description: string | null;
  amount_cents: number;
  currency: string;
  category: string; // 'membership', 'sponsorship', 'event', etc.
  billing_type: 'subscription' | 'one_time'; // subscription for recurring, one_time for invoices/events
  billing_interval: string | null; // 'year', 'month', etc. for subscriptions
  customer_types: string[]; // ['company', 'individual'] or empty for all
  revenue_tiers: string[]; // ['under_1m', '1m_5m'] or empty for all
  is_invoiceable: boolean; // Can be paid via invoice request
  sort_order: number; // For custom ordering
  metadata: Record<string, string>;
  // Event-managed product fields
  managed_by?: string; // 'event' if managed by an event
  event_id?: string; // The event ID if managed by an event
}

// Keep backward compatibility alias
export type InvoiceableProduct = BillingProduct;

/**
 * Clear the products cache (call after creating/updating/deleting products)
 */
export function clearProductsCache(): void {
  productsCache = null;
  productsCacheTime = 0;
}

/**
 * Parse comma-separated metadata value into array
 */
function parseMetadataArray(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Get all billing products from Stripe using lookup keys
 * Products must have prices with lookup_key starting with 'aao_'
 *
 * Lookup key patterns:
 * - aao_membership_* - Membership subscriptions
 * - aao_invoice_* - Invoice-only products (one-time)
 * - aao_sponsorship_* - Event sponsorships
 * - aao_event_* - Event tickets/registrations
 *
 * Product metadata fields:
 * - category: 'membership' | 'sponsorship' | 'event' (default: derived from lookup_key)
 * - display_name: Human-readable name (default: product name)
 * - customer_types: Comma-separated list of allowed customer types (empty = all)
 * - revenue_tiers: Comma-separated list of allowed revenue tiers (empty = all)
 * - invoiceable: 'true' | 'false' - Can be requested via invoice (default: true for one-time)
 * - sort_order: Number for custom ordering (default: 0)
 */
export async function getBillingProducts(): Promise<BillingProduct[]> {
  if (!stripe) {
    logger.warn('getBillingProducts: Stripe not initialized - cannot fetch products');
    return [];
  }

  // Return cached data if fresh
  if (productsCache && Date.now() - productsCacheTime < PRODUCTS_CACHE_TTL) {
    logger.debug({ count: productsCache.length }, 'getBillingProducts: Returning cached products');
    return productsCache;
  }

  try {
    // Fetch all active prices - we'll filter by lookup_key pattern
    const prices = await stripe.prices.list({
      active: true,
      expand: ['data.product'],
      limit: 100,
    });

    logger.debug({ totalPrices: prices.data.length }, 'getBillingProducts: Fetched prices from Stripe');

    const products: BillingProduct[] = [];

    for (const price of prices.data) {
      // Only include prices with our lookup key pattern
      if (!price.lookup_key?.startsWith('aao_')) {
        continue;
      }

      const product = price.product as Stripe.Product;
      if (!product || typeof product === 'string' || product.deleted) {
        continue;
      }

      const metadata = product.metadata || {};
      const lookupKey = price.lookup_key;

      // Derive category from lookup key if not in metadata
      let category = metadata.category;
      if (!category) {
        if (lookupKey.startsWith('aao_membership_')) category = 'membership';
        else if (lookupKey.startsWith('aao_invoice_')) category = 'membership'; // Legacy invoice products
        else if (lookupKey.startsWith('aao_sponsorship_')) category = 'sponsorship';
        else if (lookupKey.startsWith('aao_event_')) category = 'event';
        else category = 'other';
      }

      // Determine billing type from price
      const isRecurring = !!price.recurring;
      const billingType = isRecurring ? 'subscription' : 'one_time';
      const billingInterval = price.recurring?.interval || null;

      // Parse customer types and revenue tiers from metadata
      const customerTypes = parseMetadataArray(metadata.customer_types);
      const revenueTiers = parseMetadataArray(metadata.revenue_tiers);

      // Determine if invoiceable (default: true for one-time, configurable via metadata)
      const isInvoiceable = metadata.invoiceable !== undefined
        ? metadata.invoiceable === 'true'
        : billingType === 'one_time';

      products.push({
        lookup_key: lookupKey,
        price_id: price.id,
        product_id: product.id,
        product_name: product.name,
        display_name: metadata.display_name || product.name,
        description: product.description,
        amount_cents: price.unit_amount || 0,
        currency: price.currency,
        category,
        billing_type: billingType,
        billing_interval: billingInterval,
        customer_types: customerTypes,
        revenue_tiers: revenueTiers,
        is_invoiceable: isInvoiceable,
        sort_order: parseInt(metadata.sort_order || '0', 10),
        metadata,
        // Event-managed product fields
        managed_by: metadata.managed_by,
        event_id: metadata.event_id,
      });
    }

    // Sort by category, then by sort_order, then by amount (descending)
    products.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      return b.amount_cents - a.amount_cents; // Higher amounts first
    });

    // Update cache
    productsCache = products;
    productsCacheTime = Date.now();

    logger.debug({ count: products.length }, 'getBillingProducts: Cache refreshed from Stripe');
    return products;
  } catch (error) {
    logger.error({ err: error }, 'getBillingProducts: Error fetching billing products');
    return productsCache || [];
  }
}

/**
 * Get products filtered by customer context
 */
export async function getProductsForCustomer(options: {
  customerType?: 'company' | 'individual';
  revenueTier?: string;
  category?: string;
  invoiceableOnly?: boolean;
}): Promise<BillingProduct[]> {
  const allProducts = await getBillingProducts();

  logger.debug({
    options,
    allProductsCount: allProducts.length,
  }, 'getProductsForCustomer: Filtering products');

  const filtered = allProducts.filter(product => {
    // Filter by category if specified
    if (options.category && product.category !== options.category) {
      return false;
    }

    // Filter by invoiceable if specified
    if (options.invoiceableOnly && !product.is_invoiceable) {
      return false;
    }

    // Filter by customer type (empty array means available to all)
    if (options.customerType && product.customer_types.length > 0) {
      if (!product.customer_types.includes(options.customerType)) {
        return false;
      }
    }

    // Filter by revenue tier (empty array means available to all)
    if (options.revenueTier && product.revenue_tiers.length > 0) {
      if (!product.revenue_tiers.includes(options.revenueTier)) {
        return false;
      }
    }

    return true;
  });

  logger.debug({
    filteredCount: filtered.length,
    lookupKeys: filtered.map(p => p.lookup_key),
  }, 'getProductsForCustomer: Filtered results');

  return filtered;
}

/**
 * Get all invoice-able products (backward compatible)
 * @deprecated Use getBillingProducts() or getProductsForCustomer() instead
 */
export async function getInvoiceableProducts(): Promise<BillingProduct[]> {
  return getProductsForCustomer({ invoiceableOnly: true });
}

/**
 * Get a specific price by lookup key
 */
export async function getPriceByLookupKey(lookupKey: string): Promise<string | null> {
  if (!stripe) {
    logger.warn({ lookupKey }, 'getPriceByLookupKey: Stripe not initialized');
    return null;
  }

  // First check our cached products - this is faster and more reliable
  const cachedProducts = await getBillingProducts();
  const cachedProduct = cachedProducts.find(p => p.lookup_key === lookupKey);
  if (cachedProduct) {
    logger.info({ lookupKey, priceId: cachedProduct.price_id }, 'getPriceByLookupKey: Found price in cache');
    return cachedProduct.price_id;
  }

  // Fallback to direct Stripe query if not in cache
  logger.info({ lookupKey }, 'getPriceByLookupKey: Not in cache, querying Stripe directly');
  try {
    const prices = await stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
    });

    if (prices.data.length === 0) {
      // Log available lookup keys for debugging
      const allPrices = await stripe.prices.list({ active: true, limit: 100 });
      const availableLookupKeys = allPrices.data
        .filter(p => p.lookup_key?.startsWith('aao_'))
        .map(p => p.lookup_key);
      logger.error({
        lookupKey,
        availableLookupKeys,
      }, 'getPriceByLookupKey: No price found for lookup key in Stripe');
      return null;
    }

    logger.info({ lookupKey, priceId: prices.data[0].id }, 'getPriceByLookupKey: Found price in Stripe');
    return prices.data[0].id;
  } catch (error) {
    logger.error({ err: error, lookupKey }, 'getPriceByLookupKey: Error fetching price');
    return null;
  }
}

/**
 * Get subscription info from Stripe for an organization
 */
export async function getSubscriptionInfo(
  stripeCustomerId: string
): Promise<{
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'none';
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
      status: subscription.status as 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid',
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
 * Find or create a Stripe customer for an organization.
 * Checks for existing customer by email first to avoid duplicates.
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
    // Check for existing customer with this email
    const existingCustomers = await stripe.customers.list({
      email: data.email,
      limit: 1,
    });

    if (existingCustomers.data.length > 0) {
      const existing = existingCustomers.data[0];
      // Update existing customer with new metadata if provided
      if (data.metadata) {
        await stripe.customers.update(existing.id, {
          name: data.name,
          metadata: {
            ...existing.metadata,
            ...data.metadata,
          },
        });
      }
      logger.info({ customerId: existing.id, email: data.email }, 'Found existing Stripe customer');
      return existing.id;
    }

    // Create new customer
    const customer = await stripe.customers.create({
      email: data.email,
      name: data.name,
      metadata: data.metadata,
    });

    logger.info({ customerId: customer.id, email: data.email }, 'Created new Stripe customer');
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
    // Note: We can't expand data.lines.data.price.product (5 levels) due to Stripe's 4-level limit
    // The code below handles fetching product info separately when needed
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
              } catch (productFetchError) {
                // Log the failure so we can diagnose why product names are missing
                logger.warn({ productId: product, invoiceId: invoice.id, err: productFetchError }, 'Failed to fetch product for invoice');
                // Use description as fallback, don't cache failures
              }
            }
            productName = cachedProduct?.name || primaryLine.description || null;
          } else if (product && typeof product === 'object' && 'name' in product) {
            productId = product.id;
            productName = product.name;
            // Cache the expanded product object
            productCache.set(product.id, { id: product.id, name: product.name });
          }
        } else {
          // Log when there's no price on the line item
          logger.warn({ invoiceId: invoice.id, lineItemId: primaryLine.id }, 'Invoice line item has no price');
        }
      } else {
        // Log when invoice has no line items
        logger.warn({ invoiceId: invoice.id }, 'Invoice has no line items');
      }

      // Try additional fallbacks for product name
      if (!productName) {
        // Try invoice description (for manually created invoices)
        if (invoice.description) {
          productName = invoice.description;
        }
        // Try subscription metadata product_name (if set during checkout)
        else if (typeof invoice.subscription === 'object' && invoice.subscription?.metadata?.product_name) {
          productName = invoice.subscription.metadata.product_name;
        }
        // Log if we still couldn't get a product name for a paid invoice
        else if (invoice.amount_paid > 0) {
          logger.warn({ invoiceId: invoice.id, productId, hasDescription: !!primaryLine?.description }, 'Invoice has no product name after all fallbacks');
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

export interface InvoiceRequestData {
  companyName: string;
  contactName: string;
  contactEmail: string;
  billingAddress: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
  lookupKey: string; // Stripe price lookup key (e.g., 'aao_invoice_membership_10k')
  workosOrganizationId?: string;
  couponId?: string; // Stripe coupon ID to apply discount to the invoice
}

/**
 * Create a subscription with invoice billing and send the first invoice
 * Uses collection_method: 'send_invoice' so customer receives email with payment link
 * When paid, this creates a proper subscription that will auto-renew
 */
export async function createAndSendInvoice(
  data: InvoiceRequestData
): Promise<{ invoiceId: string; invoiceUrl: string; subscriptionId: string; discountApplied: boolean; discountWarning?: string } | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create invoice');
    return null;
  }

  // Get price ID from lookup key
  const priceId = await getPriceByLookupKey(data.lookupKey);

  if (!priceId) {
    logger.error({
      lookupKey: data.lookupKey,
    }, 'No price found for lookup key');
    return null;
  }

  try {
    // Create or find customer
    const existingCustomers = await stripe.customers.list({
      email: data.contactEmail,
      limit: 1,
    });

    let customer: Stripe.Customer;

    if (existingCustomers.data.length > 0) {
      // Update existing customer with new info
      customer = await stripe.customers.update(existingCustomers.data[0].id, {
        name: data.companyName,
        address: data.billingAddress,
        metadata: {
          contact_name: data.contactName,
          ...(data.workosOrganizationId && { workos_organization_id: data.workosOrganizationId }),
        },
      });
      logger.info({ customerId: customer.id, email: data.contactEmail }, 'Updated existing Stripe customer for invoice');
    } else {
      // Create new customer
      customer = await stripe.customers.create({
        email: data.contactEmail,
        name: data.companyName,
        address: data.billingAddress,
        metadata: {
          contact_name: data.contactName,
          invoice_request: 'true',
          ...(data.workosOrganizationId && { workos_organization_id: data.workosOrganizationId }),
        },
      });
      logger.info({ customerId: customer.id, email: data.contactEmail }, 'Created new Stripe customer for invoice');
    }

    // Verify the price exists and has a valid amount before creating subscription
    const price = await stripe.prices.retrieve(priceId);
    if (!price || price.unit_amount === null || price.unit_amount === 0) {
      logger.error({
        priceId,
        lookupKey: data.lookupKey,
        unitAmount: price?.unit_amount,
      }, 'createAndSendInvoice: Price has zero or null amount');
      return null;
    }

    logger.info({
      priceId,
      lookupKey: data.lookupKey,
      unitAmount: price.unit_amount,
      currency: price.currency,
    }, 'createAndSendInvoice: Creating subscription with verified price');

    // Validate coupon exists if provided
    let validatedCouponId: string | undefined;
    let discountWarning: string | undefined;
    if (data.couponId) {
      try {
        const coupon = await stripe.coupons.retrieve(data.couponId);
        if (!coupon || !coupon.valid) {
          discountWarning = `Coupon "${data.couponId}" is invalid or expired. Invoice sent without discount. Use grant_discount to create a valid coupon.`;
          logger.warn({
            couponId: data.couponId,
            valid: coupon?.valid,
          }, 'createAndSendInvoice: Coupon is invalid or expired, proceeding without discount');
        } else {
          validatedCouponId = data.couponId;
          logger.info({
            couponId: data.couponId,
            percentOff: coupon.percent_off,
            amountOff: coupon.amount_off,
          }, 'createAndSendInvoice: Validated coupon');
        }
      } catch (couponError) {
        // Coupon doesn't exist - log and proceed without it
        discountWarning = `Coupon "${data.couponId}" does not exist in Stripe. Invoice sent without discount. Use grant_discount to create a valid coupon first.`;
        logger.warn({
          couponId: data.couponId,
          error: couponError instanceof Error ? couponError.message : 'Unknown error',
        }, 'createAndSendInvoice: Coupon not found in Stripe, proceeding without discount');
      }
    }

    // Create subscription with invoice billing
    // This creates a subscription AND generates an invoice for the first payment
    // When the invoice is paid, the subscription becomes active and will auto-renew
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      collection_method: 'send_invoice',
      days_until_due: 30,
      // Apply coupon if validated
      ...(validatedCouponId && { discounts: [{ coupon: validatedCouponId }] }),
      metadata: {
        lookup_key: data.lookupKey,
        contact_name: data.contactName,
        ...(data.workosOrganizationId && { workos_organization_id: data.workosOrganizationId }),
      },
    });

    // Get the invoice that was created with the subscription
    const invoiceId = subscription.latest_invoice as string;

    // Verify the invoice has the expected amount before sending
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (!invoice.amount_due || invoice.amount_due === 0) {
      logger.error({
        invoiceId,
        subscriptionId: subscription.id,
        amountDue: invoice.amount_due,
        priceId,
        lookupKey: data.lookupKey,
      }, 'createAndSendInvoice: Invoice has zero amount - not sending');
      // Clean up the subscription since we can't send the invoice
      try {
        await stripe.subscriptions.cancel(subscription.id);
      } catch (cancelError) {
        logger.error({
          err: cancelError,
          subscriptionId: subscription.id,
        }, 'createAndSendInvoice: Failed to cancel orphaned subscription');
      }
      return null;
    }

    logger.info({
      invoiceId,
      subscriptionId: subscription.id,
      amountDue: invoice.amount_due,
    }, 'createAndSendInvoice: Sending invoice');

    // Send the invoice email - this finalizes the invoice and returns the updated invoice
    const sentInvoice = await stripe.invoices.sendInvoice(invoiceId);

    logger.info({
      subscriptionId: subscription.id,
      invoiceId: invoiceId,
      customerId: customer.id,
      lookupKey: data.lookupKey,
      companyName: data.companyName,
    }, 'Subscription created with invoice billing - invoice sent');

    return {
      invoiceId: invoiceId,
      invoiceUrl: sentInvoice.hosted_invoice_url || '',
      subscriptionId: subscription.id,
      discountApplied: !!validatedCouponId,
      discountWarning,
    };
  } catch (error) {
    const stripeError = error as { type?: string; code?: string; message?: string };
    logger.error({
      err: error,
      stripeErrorType: stripeError.type,
      stripeErrorCode: stripeError.code,
      stripeErrorMessage: stripeError.message,
      lookupKey: data.lookupKey,
      companyName: data.companyName,
      contactEmail: data.contactEmail,
    }, 'createAndSendInvoice: Error creating subscription with invoice');
    return null;
  }
}

export interface CheckoutSessionData {
  priceId: string;
  customerId?: string; // Existing Stripe customer ID
  customerEmail?: string; // Email if no existing customer
  successUrl: string;
  cancelUrl: string;
  workosOrganizationId?: string;
  workosUserId?: string;
  isPersonalWorkspace?: boolean;
  // Event sponsorship fields
  eventId?: string;
  eventSponsorshipId?: string;
  sponsorshipTierId?: string;
  // Discount - provide coupon ID or promotion code (not both)
  couponId?: string; // Stripe coupon ID to pre-apply
  promotionCode?: string; // Promotion code to pre-apply (mutually exclusive with couponId)
}

/**
 * Create a Stripe Checkout Session for a product
 * Handles both subscription and one-time payments
 */
export async function createCheckoutSession(
  data: CheckoutSessionData
): Promise<{ sessionId: string; url: string } | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create checkout session');
    return null;
  }

  try {
    // Fetch the price to determine if it's subscription or one-time
    const price = await stripe.prices.retrieve(data.priceId);
    const mode = price.recurring ? 'subscription' : 'payment';

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode,
      line_items: [
        {
          price: data.priceId,
          quantity: 1,
        },
      ],
      success_url: data.successUrl,
      cancel_url: data.cancelUrl,
      metadata: {
        ...(data.workosOrganizationId && { workos_organization_id: data.workosOrganizationId }),
        ...(data.workosUserId && { workos_user_id: data.workosUserId }),
        ...(data.isPersonalWorkspace !== undefined && { is_personal_workspace: String(data.isPersonalWorkspace) }),
        ...(data.eventId && { event_id: data.eventId }),
        ...(data.eventSponsorshipId && { event_sponsorship_id: data.eventSponsorshipId }),
        ...(data.sponsorshipTierId && { sponsorship_tier_id: data.sponsorshipTierId }),
      },
    };

    // Set customer or email
    if (data.customerId) {
      sessionParams.customer = data.customerId;
    } else if (data.customerEmail) {
      sessionParams.customer_email = data.customerEmail;
    }

    // Handle discounts - either pre-apply a specific coupon/promotion code, or allow user entry
    if (data.couponId) {
      // Pre-apply a specific coupon
      sessionParams.discounts = [{ coupon: data.couponId }];
      // Don't allow additional promotion codes when one is pre-applied
    } else if (data.promotionCode) {
      // Look up the promotion code to get its ID
      const promoCodes = await stripe.promotionCodes.list({ code: data.promotionCode, limit: 1 });
      if (promoCodes.data.length > 0) {
        sessionParams.discounts = [{ promotion_code: promoCodes.data[0].id }];
      } else {
        logger.warn({ promotionCode: data.promotionCode }, 'Promotion code not found, proceeding without discount');
        sessionParams.allow_promotion_codes = true;
      }
    } else {
      // Allow manual entry of promotion codes
      sessionParams.allow_promotion_codes = true;
    }
    sessionParams.billing_address_collection = 'required';

    // For one-time payments, also create invoices and customers
    // Note: customer_creation is not allowed in subscription mode - Stripe creates customers automatically
    if (mode === 'payment') {
      sessionParams.invoice_creation = {
        enabled: true,
      };
      if (!data.customerId) {
        sessionParams.customer_creation = 'always';
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    logger.info({
      sessionId: session.id,
      priceId: data.priceId,
      mode,
      workosOrganizationId: data.workosOrganizationId,
    }, 'Created checkout session');

    return {
      sessionId: session.id,
      url: session.url || '',
    };
  } catch (error) {
    logger.error({ err: error, data }, 'Error creating checkout session');
    throw error;
  }
}

// ============================================================================
// Admin Product Management
// ============================================================================

export interface CreateProductInput {
  name: string;
  description?: string;
  lookupKey: string;
  amountCents: number;
  currency?: string;
  billingType: 'subscription' | 'one_time';
  billingInterval?: 'year' | 'month';
  category: string;
  displayName?: string;
  customerTypes?: string[];
  revenueTiers?: string[];
  invoiceable?: boolean;
  sortOrder?: number;
}

export interface UpdateProductInput {
  productId: string;
  priceId: string;
  name?: string;
  description?: string;
  displayName?: string;
  category?: string;
  customerTypes?: string[];
  revenueTiers?: string[];
  invoiceable?: boolean;
  sortOrder?: number;
}

/**
 * Create a new product with price in Stripe
 * Creates both the product and an associated price with lookup key
 */
export async function createProduct(input: CreateProductInput): Promise<BillingProduct | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create product');
    return null;
  }

  // Validate lookup key format
  if (!input.lookupKey.startsWith('aao_')) {
    throw new Error('Lookup key must start with "aao_"');
  }

  try {
    // Build metadata
    const metadata: Record<string, string> = {
      category: input.category,
    };
    if (input.displayName) metadata.display_name = input.displayName;
    if (input.customerTypes?.length) metadata.customer_types = input.customerTypes.join(',');
    if (input.revenueTiers?.length) metadata.revenue_tiers = input.revenueTiers.join(',');
    if (input.invoiceable !== undefined) metadata.invoiceable = String(input.invoiceable);
    if (input.sortOrder !== undefined) metadata.sort_order = String(input.sortOrder);

    // Create the product
    const product = await stripe.products.create({
      name: input.name,
      description: input.description,
      metadata,
    });

    // Create the price with lookup key
    const priceParams: Stripe.PriceCreateParams = {
      product: product.id,
      unit_amount: input.amountCents,
      currency: input.currency || 'usd',
      lookup_key: input.lookupKey,
      transfer_lookup_key: true, // Transfer lookup key if it exists on another price
    };

    if (input.billingType === 'subscription') {
      priceParams.recurring = {
        interval: input.billingInterval || 'year',
      };
    }

    const price = await stripe.prices.create(priceParams);

    logger.info({
      productId: product.id,
      priceId: price.id,
      lookupKey: input.lookupKey,
    }, 'Created product and price in Stripe');

    // Clear cache so new product appears
    clearProductsCache();

    // Return the billing product
    return {
      lookup_key: input.lookupKey,
      price_id: price.id,
      product_id: product.id,
      product_name: product.name,
      display_name: input.displayName || product.name,
      description: product.description,
      amount_cents: input.amountCents,
      currency: input.currency || 'usd',
      category: input.category,
      billing_type: input.billingType,
      billing_interval: input.billingInterval || null,
      customer_types: input.customerTypes || [],
      revenue_tiers: input.revenueTiers || [],
      is_invoiceable: input.invoiceable ?? (input.billingType === 'one_time'),
      sort_order: input.sortOrder || 0,
      metadata,
    };
  } catch (error) {
    logger.error({ err: error, input }, 'Error creating product');
    throw error;
  }
}

/**
 * Update product metadata (cannot change price amount - need to create new price)
 */
export async function updateProductMetadata(input: UpdateProductInput): Promise<BillingProduct | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot update product');
    return null;
  }

  try {
    // Build updated metadata
    const metadata: Record<string, string> = {};
    if (input.category) metadata.category = input.category;
    if (input.displayName) metadata.display_name = input.displayName;
    if (input.customerTypes !== undefined) metadata.customer_types = input.customerTypes.join(',');
    if (input.revenueTiers !== undefined) metadata.revenue_tiers = input.revenueTiers.join(',');
    if (input.invoiceable !== undefined) metadata.invoiceable = String(input.invoiceable);
    if (input.sortOrder !== undefined) metadata.sort_order = String(input.sortOrder);

    // Update product
    const updateParams: Stripe.ProductUpdateParams = { metadata };
    if (input.name) updateParams.name = input.name;
    if (input.description !== undefined) updateParams.description = input.description;

    const product = await stripe.products.update(input.productId, updateParams);

    // Get the price to return full billing product
    const price = await stripe.prices.retrieve(input.priceId);

    logger.info({
      productId: product.id,
      priceId: input.priceId,
    }, 'Updated product metadata in Stripe');

    // Clear cache
    clearProductsCache();

    return {
      lookup_key: price.lookup_key || '',
      price_id: price.id,
      product_id: product.id,
      product_name: product.name,
      display_name: product.metadata?.display_name || product.name,
      description: product.description,
      amount_cents: price.unit_amount || 0,
      currency: price.currency,
      category: product.metadata?.category || 'other',
      billing_type: price.recurring ? 'subscription' : 'one_time',
      billing_interval: price.recurring?.interval || null,
      customer_types: parseMetadataArray(product.metadata?.customer_types),
      revenue_tiers: parseMetadataArray(product.metadata?.revenue_tiers),
      is_invoiceable: product.metadata?.invoiceable === 'true' || !price.recurring,
      sort_order: parseInt(product.metadata?.sort_order || '0', 10),
      metadata: product.metadata || {},
    };
  } catch (error) {
    logger.error({ err: error, input }, 'Error updating product');
    throw error;
  }
}

/**
 * Archive a product (deactivate the price, archive the product)
 * Note: Stripe doesn't allow deleting products with price history
 */
export async function archiveProduct(productId: string, priceId: string): Promise<boolean> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot archive product');
    return false;
  }

  try {
    // Deactivate the price
    await stripe.prices.update(priceId, { active: false });

    // Archive the product
    await stripe.products.update(productId, { active: false });

    logger.info({ productId, priceId }, 'Archived product and price in Stripe');

    // Clear cache
    clearProductsCache();

    return true;
  } catch (error) {
    logger.error({ err: error, productId, priceId }, 'Error archiving product');
    throw error;
  }
}

/**
 * Pending invoice information
 */
export interface PendingInvoice {
  id: string;
  status: 'draft' | 'open';
  amount_due: number;
  currency: string;
  created: Date;
  due_date: Date | null;
  hosted_invoice_url: string | null;
  product_name: string | null;
  customer_email: string | null;
}

/**
 * Get pending (draft or open) invoices for a Stripe customer
 * Returns invoices that are waiting for payment
 */
export async function getPendingInvoices(customerId: string): Promise<PendingInvoice[]> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot fetch pending invoices');
    return [];
  }

  try {
    const pendingInvoices: PendingInvoice[] = [];
    // Cache product info to avoid N+1 API calls
    const productCache = new Map<string, string>();

    // Fetch open invoices (sent to customer, waiting for payment)
    // Note: We can't expand data.lines.data.price.product (5 levels) due to Stripe's 4-level limit
    const openInvoices = await stripe.invoices.list({
      customer: customerId,
      status: 'open',
      limit: 10,
    });

    // Fetch draft invoices (not yet sent)
    const draftInvoices = await stripe.invoices.list({
      customer: customerId,
      status: 'draft',
      limit: 10,
    });

    // Combine and deduplicate invoices by ID (in case an invoice appears in both lists)
    const invoiceMap = new Map<string, typeof openInvoices.data[0]>();
    for (const inv of openInvoices.data) {
      invoiceMap.set(inv.id, inv);
    }
    for (const inv of draftInvoices.data) {
      if (!invoiceMap.has(inv.id)) {
        invoiceMap.set(inv.id, inv);
      }
    }
    const allInvoices = Array.from(invoiceMap.values());

    for (const invoice of allInvoices) {
      // Get product name from first line item
      let productName: string | null = null;
      const firstLine = invoice.lines?.data[0];
      if (firstLine?.price?.product) {
        const product = firstLine.price.product;
        if (typeof product === 'object' && 'name' in product) {
          productName = product.name;
        } else if (typeof product === 'string') {
          // Product is a string ID, fetch it (with caching)
          let cachedName = productCache.get(product);
          if (cachedName === undefined) {
            try {
              const productObj = await stripe.products.retrieve(product);
              cachedName = productObj.name;
              productCache.set(product, cachedName);
            } catch {
              // Use line description as fallback
              cachedName = firstLine.description || '';
              productCache.set(product, cachedName);
            }
          }
          productName = cachedName || null;
        }
      }

      pendingInvoices.push({
        id: invoice.id,
        status: invoice.status as 'draft' | 'open',
        amount_due: invoice.amount_due,
        currency: invoice.currency,
        created: new Date(invoice.created * 1000),
        due_date: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
        hosted_invoice_url: invoice.hosted_invoice_url || null,
        product_name: productName,
        customer_email: typeof invoice.customer_email === 'string' ? invoice.customer_email : null,
      });
    }

    logger.debug({ customerId, count: pendingInvoices.length }, 'Fetched pending invoices');
    return pendingInvoices;
  } catch (error) {
    logger.error({ err: error, customerId }, 'Error fetching pending invoices');
    return [];
  }
}

/**
 * Get pending invoices by customer email
 * Useful when we don't have a Stripe customer ID
 */
export async function getPendingInvoicesByEmail(email: string): Promise<PendingInvoice[]> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot fetch pending invoices');
    return [];
  }

  try {
    // Find customer by email
    const customers = await stripe.customers.list({
      email,
      limit: 1,
    });

    if (customers.data.length === 0) {
      return [];
    }

    return getPendingInvoices(customers.data[0].id);
  } catch (error) {
    logger.error({ err: error, email }, 'Error fetching pending invoices by email');
    return [];
  }
}

/**
 * Open invoice with customer information
 * Used for listing all unpaid invoices across all customers
 */
export interface OpenInvoiceWithCustomer {
  id: string;
  status: 'draft' | 'open';
  amount_due: number;
  currency: string;
  created: Date;
  due_date: Date | null;
  hosted_invoice_url: string | null;
  product_name: string | null;
  customer_id: string;
  customer_name: string | null;
  customer_email: string | null;
  workos_organization_id: string | null;
}

/**
 * Convert a Stripe invoice to OpenInvoiceWithCustomer format
 */
function parseStripeInvoice(invoice: Stripe.Invoice): OpenInvoiceWithCustomer | null {
  const customer = invoice.customer;
  let customerId: string;
  let customerName: string | null = null;
  let customerEmail: string | null = null;
  let workosOrgId: string | null = null;

  if (typeof customer === 'string') {
    customerId = customer;
  } else if (customer && 'id' in customer && !('deleted' in customer)) {
    // Customer is expanded and not deleted
    customerId = customer.id;
    customerName = customer.name || null;
    customerEmail = customer.email || null;
    if (customer.metadata?.workos_organization_id) {
      workosOrgId = customer.metadata.workos_organization_id;
    }
  } else if (customer && 'id' in customer) {
    // Deleted customer - just get the ID
    customerId = customer.id;
  } else {
    return null; // Skip invoices without customer
  }

  // Get product name from first line item
  let productName: string | null = null;
  const firstLine = invoice.lines?.data[0];
  if (firstLine?.price?.product) {
    const product = firstLine.price.product;
    if (typeof product === 'object' && 'name' in product) {
      productName = product.name;
    }
  }

  return {
    id: invoice.id,
    status: (invoice.status === 'draft' || invoice.status === 'open') ? invoice.status : 'open',
    amount_due: invoice.amount_due,
    currency: invoice.currency,
    created: new Date(invoice.created * 1000),
    due_date: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    hosted_invoice_url: invoice.hosted_invoice_url || null,
    product_name: productName,
    customer_id: customerId,
    customer_name: customerName,
    customer_email: customerEmail || (typeof invoice.customer_email === 'string' ? invoice.customer_email : null),
    workos_organization_id: workosOrgId,
  };
}

/**
 * Get ALL open invoices across all Stripe customers
 * This queries Stripe directly, not our database, so it finds invoices
 * even for customers not linked to organizations in our system.
 */
export async function getAllOpenInvoices(limit: number = 50): Promise<OpenInvoiceWithCustomer[]> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot fetch open invoices');
    return [];
  }

  try {
    // Use a Map to deduplicate invoices by ID
    const invoiceMap = new Map<string, OpenInvoiceWithCustomer>();

    // Query Stripe directly for all open invoices (sent, waiting for payment)
    for await (const invoice of stripe.invoices.list({
      status: 'open',
      limit: 100,
      expand: ['data.customer', 'data.lines.data.price.product'],
    })) {
      const parsed = parseStripeInvoice(invoice);
      if (parsed && !invoiceMap.has(parsed.id)) {
        invoiceMap.set(parsed.id, parsed);
        if (invoiceMap.size >= limit) break;
      }
    }

    // Also get draft invoices (not yet sent)
    if (invoiceMap.size < limit) {
      for await (const invoice of stripe.invoices.list({
        status: 'draft',
        limit: 100,
        expand: ['data.customer', 'data.lines.data.price.product'],
      })) {
        const parsed = parseStripeInvoice(invoice);
        if (parsed && !invoiceMap.has(parsed.id)) {
          invoiceMap.set(parsed.id, parsed);
          if (invoiceMap.size >= limit) break;
        }
      }
    }

    const allInvoices = Array.from(invoiceMap.values());
    logger.info({ count: allInvoices.length }, 'Fetched all open invoices from Stripe');
    return allInvoices;
  } catch (error) {
    logger.error({ err: error }, 'Error fetching all open invoices');
    return [];
  }
}

/**
 * Void an invoice (cancel it)
 * Only works on open or uncollectible invoices
 */
export async function voidInvoice(invoiceId: string): Promise<boolean> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot void invoice');
    return false;
  }

  try {
    const invoice = await stripe.invoices.voidInvoice(invoiceId);
    logger.info({ invoiceId, status: invoice.status }, 'Invoice voided');
    return true;
  } catch (error) {
    logger.error({ err: error, invoiceId }, 'Error voiding invoice');
    return false;
  }
}

/**
 * Delete a draft invoice
 * Only works on draft invoices (not yet finalized)
 */
export async function deleteDraftInvoice(invoiceId: string): Promise<boolean> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot delete invoice');
    return false;
  }

  try {
    await stripe.invoices.del(invoiceId);
    logger.info({ invoiceId }, 'Draft invoice deleted');
    return true;
  } catch (error) {
    logger.error({ err: error, invoiceId }, 'Error deleting draft invoice');
    return false;
  }
}

// ============================================================================
// Event Sponsorship Product Management
// ============================================================================

export interface EventSponsorshipProductInput {
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  defaultAmountCents?: number;
}

/**
 * Create or update a Stripe product for event sponsorships
 * Called automatically when sponsorship tiers are saved on an event
 * Returns the Stripe product ID
 */
export async function createEventSponsorshipProduct(input: EventSponsorshipProductInput): Promise<string | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create event sponsorship product');
    return null;
  }

  const lookupKey = `aao_sponsorship_${input.eventSlug.replace(/-/g, '_')}`;
  const productName = `${input.eventTitle} Sponsorship`;
  const defaultAmount = input.defaultAmountCents || 500000; // Default $5000

  try {
    // Check if a product with this lookup key already exists
    const existingPrices = await stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
      expand: ['data.product'],
    });

    if (existingPrices.data.length > 0) {
      const existingPrice = existingPrices.data[0];
      const product = existingPrice.product as Stripe.Product;

      // Update the product name if it changed
      if (product && typeof product !== 'string' && !product.deleted) {
        if (product.name !== productName) {
          await stripe.products.update(product.id, { name: productName });
          logger.info({ productId: product.id, lookupKey }, 'Updated existing event sponsorship product name');
        }
        return product.id;
      }
    }

    // Build metadata
    const metadata: Record<string, string> = {
      category: 'sponsorship',
      display_name: productName,
      event_id: input.eventId,
      managed_by: 'event', // Mark as event-managed
    };

    // Create the product
    const product = await stripe.products.create({
      name: productName,
      description: `Sponsorship opportunities for ${input.eventTitle}`,
      metadata,
    });

    // Create the price with lookup key
    await stripe.prices.create({
      product: product.id,
      unit_amount: defaultAmount,
      currency: 'usd',
      lookup_key: lookupKey,
      transfer_lookup_key: true,
    });

    logger.info({
      productId: product.id,
      lookupKey,
      eventId: input.eventId,
    }, 'Created event sponsorship product in Stripe');

    // Clear cache so new product appears
    clearProductsCache();

    return product.id;
  } catch (error) {
    logger.error({ err: error, input }, 'Error creating event sponsorship product');
    throw error;
  }
}

/**
 * Get product info including whether it's managed by an event
 */
export async function getProductWithEventInfo(productId: string): Promise<{
  product_id: string;
  product_name: string;
  managed_by?: string;
  event_id?: string;
} | null> {
  if (!stripe) {
    return null;
  }

  try {
    const product = await stripe.products.retrieve(productId);
    if (product.deleted) return null;

    return {
      product_id: product.id,
      product_name: product.name,
      managed_by: product.metadata?.managed_by,
      event_id: product.metadata?.event_id,
    };
  } catch (error) {
    logger.error({ err: error, productId }, 'Error getting product info');
    return null;
  }
}

// ============================================================================
// Coupons and Promotion Codes
// ============================================================================

export interface CreateCouponInput {
  name: string;
  percent_off?: number;
  amount_off_cents?: number;
  currency?: string;
  duration: 'once' | 'repeating' | 'forever';
  duration_in_months?: number;
  max_redemptions?: number;
  redeem_by?: Date;
  metadata?: Record<string, string>;
}

export interface CreatePromotionCodeInput {
  coupon_id: string;
  code: string;
  max_redemptions?: number;
  expires_at?: Date;
  first_time_transaction?: boolean;
  metadata?: Record<string, string>;
}

/**
 * Create a Stripe coupon with percentage or fixed amount discount
 */
export async function createCoupon(input: CreateCouponInput): Promise<{
  coupon_id: string;
  name: string;
} | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create coupon');
    return null;
  }

  try {
    const params: Stripe.CouponCreateParams = {
      name: input.name,
      duration: input.duration,
      metadata: input.metadata,
    };

    if (input.percent_off !== undefined) {
      params.percent_off = input.percent_off;
    } else if (input.amount_off_cents !== undefined) {
      params.amount_off = input.amount_off_cents;
      params.currency = input.currency || 'usd';
    }

    if (input.duration === 'repeating' && input.duration_in_months) {
      params.duration_in_months = input.duration_in_months;
    }

    if (input.max_redemptions) {
      params.max_redemptions = input.max_redemptions;
    }

    if (input.redeem_by) {
      params.redeem_by = Math.floor(input.redeem_by.getTime() / 1000);
    }

    const coupon = await stripe.coupons.create(params);

    logger.info({
      couponId: coupon.id,
      name: input.name,
      percentOff: input.percent_off,
      amountOffCents: input.amount_off_cents,
    }, 'Created Stripe coupon');

    return {
      coupon_id: coupon.id,
      name: coupon.name || input.name,
    };
  } catch (error) {
    logger.error({ err: error, input }, 'Error creating coupon');
    return null;
  }
}

/**
 * Create a promotion code for an existing coupon
 */
export async function createPromotionCode(input: CreatePromotionCodeInput): Promise<{
  promotion_code_id: string;
  code: string;
  coupon_id: string;
} | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create promotion code');
    return null;
  }

  try {
    const params: Stripe.PromotionCodeCreateParams = {
      promotion: {
        type: 'coupon',
        coupon: input.coupon_id,
      },
      code: input.code.toUpperCase(),
      metadata: input.metadata,
    };

    if (input.max_redemptions) {
      params.max_redemptions = input.max_redemptions;
    }

    if (input.expires_at) {
      params.expires_at = Math.floor(input.expires_at.getTime() / 1000);
    }

    if (input.first_time_transaction !== undefined) {
      params.restrictions = {
        first_time_transaction: input.first_time_transaction,
      };
    }

    const promoCode = await stripe.promotionCodes.create(params);

    logger.info({
      promotionCodeId: promoCode.id,
      code: promoCode.code,
      couponId: input.coupon_id,
    }, 'Created Stripe promotion code');

    return {
      promotion_code_id: promoCode.id,
      code: promoCode.code,
      coupon_id: input.coupon_id,
    };
  } catch (error) {
    logger.error({ err: error, input }, 'Error creating promotion code');
    return null;
  }
}

/**
 * Create a coupon and promotion code for a specific organization
 * Generates a unique code based on org name
 */
export async function createOrgDiscount(
  orgId: string,
  orgName: string,
  options: {
    percent_off?: number;
    amount_off_cents?: number;
    duration?: 'once' | 'repeating' | 'forever';
    reason?: string;
  }
): Promise<{
  coupon_id: string;
  promotion_code: string;
} | null> {
  if (!stripe) {
    logger.warn('Stripe not initialized - cannot create org discount');
    return null;
  }

  // Generate a unique code from org name
  const baseCode = orgName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .substring(0, 10);
  const uniqueCode = `${baseCode}${Date.now().toString(36).toUpperCase().slice(-4)}`;

  const discountDescription = options.percent_off
    ? `${options.percent_off}% off`
    : `$${((options.amount_off_cents || 0) / 100).toFixed(2)} off`;

  // Create the coupon
  const coupon = await createCoupon({
    name: `${orgName} - ${discountDescription}`,
    percent_off: options.percent_off,
    amount_off_cents: options.amount_off_cents,
    duration: options.duration || 'forever',
    metadata: {
      workos_organization_id: orgId,
      reason: options.reason || 'Organization discount',
    },
  });

  if (!coupon) {
    return null;
  }

  // Create the promotion code
  const promoCode = await createPromotionCode({
    coupon_id: coupon.coupon_id,
    code: uniqueCode,
    metadata: {
      workos_organization_id: orgId,
    },
  });

  if (!promoCode) {
    // Clean up the coupon if promo code creation failed
    try {
      await stripe.coupons.del(coupon.coupon_id);
    } catch {
      // Ignore cleanup errors
    }
    return null;
  }

  logger.info({
    orgId,
    orgName,
    couponId: coupon.coupon_id,
    promotionCode: promoCode.code,
  }, 'Created organization discount');

  return {
    coupon_id: coupon.coupon_id,
    promotion_code: promoCode.code,
  };
}
