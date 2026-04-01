/**
 * One-off script: Create a backdated invoice with configurable terms.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_... \
 *   CUSTOMER_EMAIL=user@example.com \
 *   COMPANY_NAME="Acme Inc" \
 *   CONTACT_NAME="Jane Doe" \
 *   INVOICE_DATE=2026-03-01 \
 *   DUE_DATE=2026-04-30 \
 *   npx tsx scripts/backdate-salesforce-invoice.ts [--dry-run]
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY  - Stripe API key (required)
 *   CUSTOMER_EMAIL     - Customer email (required)
 *   COMPANY_NAME       - Company name for the invoice (required)
 *   CONTACT_NAME       - Contact person name (required)
 *   INVOICE_DATE       - Invoice date as YYYY-MM-DD (required)
 *   DUE_DATE           - Due date as YYYY-MM-DD (required)
 *   LOOKUP_KEY         - Stripe price lookup key (default: aao_membership_leader_50000)
 *   DAYS_UNTIL_DUE     - Payment terms in days (default: 60)
 */

import Stripe from 'stripe';

// ─── Configuration from environment ─────────────────────────────────────────
const CUSTOMER_EMAIL = process.env.CUSTOMER_EMAIL;
const COMPANY_NAME = process.env.COMPANY_NAME;
const CONTACT_NAME = process.env.CONTACT_NAME;
const LOOKUP_KEY = process.env.LOOKUP_KEY || 'aao_membership_leader_50000';
const DAYS_UNTIL_DUE = parseInt(process.env.DAYS_UNTIL_DUE || '60', 10);
const INVOICE_DATE_STR = process.env.INVOICE_DATE;
const DUE_DATE_STR = process.env.DUE_DATE;

if (!CUSTOMER_EMAIL || !COMPANY_NAME || !CONTACT_NAME || !INVOICE_DATE_STR || !DUE_DATE_STR) {
  console.error('Required env vars: CUSTOMER_EMAIL, COMPANY_NAME, CONTACT_NAME, INVOICE_DATE, DUE_DATE');
  process.exit(1);
}

// Use noon UTC to avoid timezone rendering issues on Stripe invoice PDFs
const INVOICE_DATE = new Date(`${INVOICE_DATE_STR}T12:00:00Z`);
const DUE_DATE = new Date(`${DUE_DATE_STR}T12:00:00Z`);

if (isNaN(INVOICE_DATE.getTime()) || isNaN(DUE_DATE.getTime())) {
  console.error('Invalid date format. Use YYYY-MM-DD.');
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY not set');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2026-03-25.dahlia' as Stripe.LatestApiVersion,
});

async function main() {
  // 1. Find the price by lookup key
  const prices = await stripe.prices.list({
    lookup_keys: [LOOKUP_KEY],
    active: true,
    expand: ['data.product'],
  });

  if (prices.data.length === 0) {
    console.error(`No active price found for lookup key: ${LOOKUP_KEY}`);
    process.exit(1);
  }

  const price = prices.data[0];
  const product = price.product as Stripe.Product;
  console.log(`Product: ${product.name} (${price.lookup_key})`);
  console.log(`Amount: ${(price.unit_amount! / 100).toFixed(2)} ${price.currency.toUpperCase()}`);
  console.log(`Invoice date: ${INVOICE_DATE.toISOString().split('T')[0]}`);
  console.log(`Terms: net-${DAYS_UNTIL_DUE}`);

  if (dryRun) {
    console.log('\n--dry-run: Would create subscription + backdated invoice. Exiting.');
    return;
  }

  // 2. Find or create customer
  const existing = await stripe.customers.list({ email: CUSTOMER_EMAIL, limit: 1 });
  let customer: Stripe.Customer;

  if (existing.data.length > 0) {
    customer = existing.data[0];
    console.log(`\nFound existing customer: ${customer.id}`);
  } else {
    customer = await stripe.customers.create({
      email: CUSTOMER_EMAIL,
      name: COMPANY_NAME,
      metadata: { contact_name: CONTACT_NAME },
    });
    console.log(`\nCreated customer: ${customer.id}`);
  }

  // 3. Create subscription with backdated start and custom terms
  const invoiceDateUnix = Math.floor(INVOICE_DATE.getTime() / 1000);

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    collection_method: 'send_invoice',
    days_until_due: DAYS_UNTIL_DUE,
    backdate_start_date: invoiceDateUnix,
    metadata: {
      lookup_key: LOOKUP_KEY,
      contact_name: CONTACT_NAME,
      note: 'Backdated invoice created via script',
    },
  });

  console.log(`\nSubscription created: ${subscription.id}`);

  // 4. Get the draft invoice
  const invoiceId = subscription.latest_invoice as string;
  const invoice = await stripe.invoices.retrieve(invoiceId);

  console.log(`Draft invoice: ${invoice.id}`);
  console.log(`Amount due: ${(invoice.amount_due / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`);
  console.log(`Status: ${invoice.status}`);

  if (invoice.amount_due === 0) {
    console.error('Invoice has zero amount — aborting');
    await stripe.subscriptions.cancel(subscription.id);
    process.exit(1);
  }

  // 5. Set invoice date and due date on draft invoice before sending
  const dueDateUnix = Math.floor(DUE_DATE.getTime() / 1000);
  await stripe.invoices.update(invoiceId, {
    effective_at: invoiceDateUnix,
    due_date: dueDateUnix,
  });

  // 6. Send the invoice (auto-finalizes with the effective_at and due_date already set)
  const sentInvoice = await stripe.invoices.sendInvoice(invoiceId);

  console.log(`\nInvoice effective date: ${new Date(sentInvoice.effective_at! * 1000).toISOString().split('T')[0]}`);
  console.log(`Due date: ${new Date(sentInvoice.due_date! * 1000).toISOString().split('T')[0]}`);

  console.log(`\nInvoice sent!`);
  console.log(`Invoice URL: ${sentInvoice.hosted_invoice_url}`);
  console.log(`PDF: ${sentInvoice.invoice_pdf}`);
  console.log(`Invoice number: ${sentInvoice.number}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
