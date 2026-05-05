import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { buildSubscriptionSummary } from '../../src/billing/subscription-summary.js';

/** Minimal logger that swallows everything. */
const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof buildSubscriptionSummary>[2];

function makeStripe(opts: {
  invoice?: Partial<Stripe.Invoice> | null;
  product?: Partial<Stripe.Product>;
  invoiceFetchError?: boolean;
} = {}): Stripe {
  const invoicesRetrieve = vi.fn(async () => {
    if (opts.invoiceFetchError) throw new Error('Stripe invoice fetch failed');
    return opts.invoice as Stripe.Invoice;
  });
  const productsRetrieve = vi.fn(async () => (opts.product ?? { name: 'AAO Membership' }) as Stripe.Product);
  return {
    invoices: { retrieve: invoicesRetrieve },
    products: { retrieve: productsRetrieve },
  } as unknown as Stripe;
}

function makeSubscription(opts: {
  unitAmount?: number;
  interval?: 'year' | 'month';
  latestInvoice?: string | Stripe.Invoice | null;
  productId?: string;
  currency?: string;
} = {}): Stripe.Subscription {
  return {
    id: 'sub_test',
    currency: opts.currency ?? 'usd',
    latest_invoice: opts.latestInvoice ?? 'in_test',
    items: {
      data: [
        {
          price: {
            unit_amount: opts.unitAmount ?? 1500000,
            currency: opts.currency ?? 'usd',
            recurring: { interval: opts.interval ?? 'year' },
            product: opts.productId ?? 'prod_test',
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

describe('buildSubscriptionSummary', () => {
  it('returns the actual paid amount and Paid status for a normal Member checkout', async () => {
    const stripe = makeStripe({
      invoice: {
        amount_paid: 1500000,
        total: 1500000,
        amount_due: 0,
        status: 'paid',
        collection_method: 'charge_automatically',
        total_discount_amounts: null,
      },
    });
    const sub = makeSubscription({ unitAmount: 1500000 });

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result.amount).toBe(1500000);
    expect(result.listAmount).toBeUndefined();
    expect(result.discountSummary).toBeUndefined();
    expect(result.paymentStatus).toBe('paid');
    expect(result.invoiceTermsDays).toBeUndefined();
  });

  it('reports the post-discount amount and surfaces discount summary (Voise Tech case)', async () => {
    const stripe = makeStripe({
      invoice: {
        amount_paid: 1000000,
        total: 1000000,
        amount_due: 0,
        status: 'paid',
        collection_method: 'charge_automatically',
        total_discount_amounts: [{ amount: 500000, discount: 'di_test' }],
      },
    });
    const sub = makeSubscription({ unitAmount: 1500000 });

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result.amount).toBe(1000000);
    expect(result.listAmount).toBe(1500000);
    expect(result.discountSummary).toBe('$5,000 discount');
    expect(result.paymentStatus).toBe('paid');
  });

  it('shows Net 30 invoice_sent_pending for unpaid send_invoice subscription', async () => {
    const created = 1_700_000_000;
    const due = created + 30 * 86400;
    const stripe = makeStripe({
      invoice: {
        amount_paid: 0,
        total: 1000000,
        amount_due: 1000000,
        status: 'open',
        collection_method: 'send_invoice',
        created,
        due_date: due,
        total_discount_amounts: [{ amount: 500000, discount: 'di_test' }],
      },
    });
    const sub = makeSubscription({ unitAmount: 1500000 });

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result.amount).toBe(1000000);
    expect(result.listAmount).toBe(1500000);
    expect(result.discountSummary).toBe('$5,000 discount');
    expect(result.paymentStatus).toBe('invoice_sent_pending');
    expect(result.invoiceTermsDays).toBe(30);
  });

  it('reports Net 0 (due upon receipt) when send_invoice has no due_date', async () => {
    const stripe = makeStripe({
      invoice: {
        amount_paid: 0,
        total: 1000000,
        amount_due: 1000000,
        status: 'open',
        collection_method: 'send_invoice',
        created: 1_700_000_000,
        due_date: null,
        total_discount_amounts: null,
      },
    });
    const sub = makeSubscription({ unitAmount: 1000000 });

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result.paymentStatus).toBe('invoice_sent_pending');
    expect(result.invoiceTermsDays).toBe(0);
  });

  it('falls back to list price and unknown status when invoice fetch fails', async () => {
    const stripe = makeStripe({ invoiceFetchError: true });
    const sub = makeSubscription({ unitAmount: 1500000 });

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result.amount).toBe(1500000);
    expect(result.listAmount).toBeUndefined();
    expect(result.discountSummary).toBeUndefined();
    expect(result.paymentStatus).toBe('unknown');
  });

  it('classifies uncollectible/void invoices as payment_failed', async () => {
    const stripe = makeStripe({
      invoice: {
        amount_paid: 0,
        total: 1500000,
        amount_due: 1500000,
        status: 'uncollectible',
        collection_method: 'charge_automatically',
        total_discount_amounts: null,
      },
    });
    const sub = makeSubscription({ unitAmount: 1500000 });

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result.paymentStatus).toBe('payment_failed');
  });

  it('classifies open invoice on charge_automatically as payment_pending (rare async flow)', async () => {
    const stripe = makeStripe({
      invoice: {
        amount_paid: 0,
        total: 1500000,
        amount_due: 1500000,
        status: 'open',
        collection_method: 'charge_automatically',
        total_discount_amounts: null,
      },
    });
    const sub = makeSubscription({ unitAmount: 1500000 });

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result.paymentStatus).toBe('payment_pending');
  });

  it('returns empty summary when subscription has no items', async () => {
    const stripe = makeStripe();
    const sub = { id: 'sub_test', items: { data: [] } } as unknown as Stripe.Subscription;

    const result = await buildSubscriptionSummary(stripe, sub, noopLogger);

    expect(result).toEqual({});
  });
});
