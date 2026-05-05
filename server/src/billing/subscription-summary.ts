/**
 * Build a rich subscription summary for the "New Member!" Slack notification.
 *
 * The earlier `fetchProductInfo` returned `price.unit_amount` — the catalog
 * list price, ignoring any coupon. So Voise Tech's $5K-discounted Member tier
 * was announced at $15,000 even though Sabarish only paid $10K. This helper
 * returns the *actual* amount (post-discount) plus payment status so admins
 * can tell at a glance whether the invoice has been collected.
 *
 * Reads:
 *   - subscription.items[0].price (catalog amount + interval)
 *   - subscription.latest_invoice (fetched inline; the webhook payload only
 *     ships the id, not the expanded object). Discount cents and payment
 *     status both come from the invoice — that's the source of truth for
 *     what the customer is actually being charged this period.
 */

import type Stripe from 'stripe';
import type { Logger } from 'pino';

export interface SubscriptionSummary {
  /** Stripe product name, e.g. "AAO Membership". */
  productName?: string;
  /**
   * What the customer is actually paying this period, in cents. Falls back
   * to `price.unit_amount` if the invoice can't be fetched. Always reflects
   * any discount applied at the invoice level.
   */
  amount?: number;
  /** Catalog price before discount. Only set when it differs from `amount`. */
  listAmount?: number;
  /**
   * One-line summary of the discount, e.g. "$5,000 discount". Empty when
   * there's no discount on the invoice.
   */
  discountSummary?: string;
  currency?: string;
  /** Stripe billing interval — 'year' / 'month' / etc. */
  interval?: string;
  /**
   * Where the first invoice currently sits.
   *   'paid'                  — fully paid (charge_automatically + card OK,
   *                             OR send_invoice that was paid)
   *   'invoice_sent_pending'  — invoice sent for manual payment, not paid yet
   *   'payment_failed'        — uncollectible / void
   *   'payment_pending'       — invoice in 'open' on charge_automatically
   *                             (rare, e.g. async payment method)
   *   'unknown'               — couldn't fetch the invoice
   */
  paymentStatus?: 'paid' | 'invoice_sent_pending' | 'payment_failed' | 'payment_pending' | 'unknown';
  /** For send_invoice mode: days from invoice creation to due_date. 0 = "due upon receipt". */
  invoiceTermsDays?: number;
}

export async function buildSubscriptionSummary(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  logger: Logger,
): Promise<SubscriptionSummary> {
  const firstItem = subscription.items?.data?.[0];
  if (!firstItem?.price) return {};

  const listAmount = firstItem.price.unit_amount ?? undefined;
  const interval = firstItem.price.recurring?.interval;
  const currency = subscription.currency ?? firstItem.price.currency;

  let productName: string | undefined;
  if (firstItem.price.product) {
    try {
      const product = (await stripe.products.retrieve(
        firstItem.price.product as string,
      )) as Stripe.Product;
      productName = product.name;
    } catch (err) {
      logger.debug({ err }, 'Failed to retrieve Stripe product metadata (non-critical)');
    }
  }

  // Try to use the actual invoice for the most precise amount + discount +
  // payment status. Webhook payloads ship `latest_invoice` as an id, not an
  // expanded object — re-fetch it inline.
  const latestInvoiceRef = subscription.latest_invoice;
  let invoice: Stripe.Invoice | null = null;
  if (typeof latestInvoiceRef === 'string') {
    try {
      invoice = await stripe.invoices.retrieve(latestInvoiceRef);
    } catch (err) {
      logger.warn(
        { err, subscriptionId: subscription.id, invoiceId: latestInvoiceRef },
        'Failed to fetch latest invoice for subscription summary; falling back to list price',
      );
    }
  } else if (latestInvoiceRef && typeof latestInvoiceRef === 'object') {
    invoice = latestInvoiceRef as Stripe.Invoice;
  }

  if (!invoice) {
    return {
      productName,
      amount: listAmount,
      currency,
      interval,
      paymentStatus: 'unknown',
    };
  }

  const actualAmount = invoiceAmountForDisplay(invoice);
  const discountCents = totalDiscountCents(invoice);
  const discountSummary = discountCents > 0 ? `${formatCents(discountCents, currency)} discount` : undefined;
  const showList =
    listAmount !== undefined &&
    actualAmount !== undefined &&
    listAmount !== actualAmount;

  return {
    productName,
    amount: actualAmount ?? listAmount,
    listAmount: showList ? listAmount : undefined,
    discountSummary,
    currency,
    interval,
    paymentStatus: classifyInvoiceStatus(invoice),
    invoiceTermsDays: computeInvoiceTermsDays(invoice),
  };
}

/**
 * Pick the right "what they're paying this period" number off the invoice.
 * Prefer `amount_paid` once paid; fall back to `total` (post-discount, post-tax)
 * for unpaid open/draft invoices.
 */
function invoiceAmountForDisplay(invoice: Stripe.Invoice): number | undefined {
  if (invoice.amount_paid && invoice.amount_paid > 0) return invoice.amount_paid;
  if (typeof invoice.total === 'number') return invoice.total;
  if (typeof invoice.amount_due === 'number') return invoice.amount_due;
  return undefined;
}

function totalDiscountCents(invoice: Stripe.Invoice): number {
  const entries = invoice.total_discount_amounts;
  if (!entries || entries.length === 0) return 0;
  return entries.reduce((sum, e) => sum + (e.amount || 0), 0);
}

function classifyInvoiceStatus(
  invoice: Stripe.Invoice,
): SubscriptionSummary['paymentStatus'] {
  const status = invoice.status;
  const collection = invoice.collection_method;

  if (status === 'paid') return 'paid';
  if (status === 'open' && collection === 'send_invoice') return 'invoice_sent_pending';
  if (status === 'open' && collection === 'charge_automatically') return 'payment_pending';
  if (status === 'uncollectible') return 'payment_failed';
  if (status === 'void') return 'payment_failed';
  // 'draft' or null: not enough signal to call it; treat as unknown.
  return 'unknown';
}

function computeInvoiceTermsDays(invoice: Stripe.Invoice): number | undefined {
  if (invoice.collection_method !== 'send_invoice') return undefined;
  if (!invoice.due_date) return 0; // due upon receipt
  if (!invoice.created) return undefined;
  const seconds = invoice.due_date - invoice.created;
  return Math.max(0, Math.round(seconds / 86400));
}

function formatCents(cents: number, currency: string | undefined): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency ?? 'usd').toUpperCase(),
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
