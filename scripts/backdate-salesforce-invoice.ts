/**
 * One-off script: Create a backdated March 1 invoice for Salesforce with net-60 terms.
 *
 * Usage:
 *   npx tsx scripts/backdate-salesforce-invoice.ts [--dry-run]
 *
 * Requires STRIPE_SECRET_KEY in environment.
 */

import Stripe from 'stripe';

// ─── Configuration ───────────────────────────────────────────────────────────
const CUSTOMER_EMAIL = 'gjoynt@salesforce.com';
const COMPANY_NAME = 'Salesforce';
const CONTACT_NAME = 'Gabe Joynt';
const LOOKUP_KEY = 'aao_membership_leader_50000';
const DAYS_UNTIL_DUE = 60; // net-60
const INVOICE_DATE = new Date('2026-03-01T00:00:00Z');
const DUE_DATE = new Date('2026-04-30T00:00:00Z'); // March 1 + 60 days
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

  // 3. Create subscription with backdated start and net-60
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
      note: 'Backdated invoice per Salesforce procurement requirement',
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
