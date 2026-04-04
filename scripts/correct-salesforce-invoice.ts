/**
 * Void a disputed invoice and reissue with corrections (e.g. PO number).
 *
 * Usage:
 *   source .env.local && STRIPE_SECRET_KEY="$STRIPE_ADMIN_KEY" \
 *   DISPUTED_INVOICE_NUMBER=XUQR69S9-0003 PO_NUMBER=P116659 \
 *   INVOICE_DATE=2026-03-01 DUE_DATE=2026-04-30 \
 *   npx tsx scripts/correct-salesforce-invoice.ts [--dry-run]
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY          - Stripe API key (required)
 *   DISPUTED_INVOICE_NUMBER    - Invoice number to void (required)
 *   PO_NUMBER                  - PO number to add to corrected invoice (required)
 *   INVOICE_DATE               - Invoice date as YYYY-MM-DD (required)
 *   DUE_DATE                   - Due date as YYYY-MM-DD (required)
 *   LOOKUP_KEY                 - Stripe price lookup key (default: aao_membership_leader_50000)
 *   DAYS_UNTIL_DUE             - Payment terms in days (default: 60)
 */

import Stripe from 'stripe';

const DISPUTED_INVOICE_NUMBER = process.env.DISPUTED_INVOICE_NUMBER;
const PO_NUMBER = process.env.PO_NUMBER;
const LOOKUP_KEY = process.env.LOOKUP_KEY || 'aao_membership_leader_50000';
const INVOICE_DATE_STR = process.env.INVOICE_DATE;
const DUE_DATE_STR = process.env.DUE_DATE;
const DAYS_UNTIL_DUE = parseInt(process.env.DAYS_UNTIL_DUE || '60', 10);

if (!DISPUTED_INVOICE_NUMBER || !PO_NUMBER || !INVOICE_DATE_STR || !DUE_DATE_STR) {
  console.error('Required env vars: DISPUTED_INVOICE_NUMBER, PO_NUMBER, INVOICE_DATE, DUE_DATE');
  process.exit(1);
}

const INVOICE_DATE = new Date(`${INVOICE_DATE_STR}T12:00:00Z`);
const DUE_DATE = new Date(`${DUE_DATE_STR}T12:00:00Z`);

if (isNaN(INVOICE_DATE.getTime()) || isNaN(DUE_DATE.getTime())) {
  console.error('Invalid date format. Use YYYY-MM-DD.');
  process.exit(1);
}

if (DUE_DATE <= INVOICE_DATE) {
  console.error('DUE_DATE must be after INVOICE_DATE.');
  process.exit(1);
}

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
  // 1. Find the disputed invoice
  const invoices = await stripe.invoices.search({
    query: `number:"${DISPUTED_INVOICE_NUMBER}"`,
  });

  if (invoices.data.length === 0) {
    console.error(`Invoice ${DISPUTED_INVOICE_NUMBER} not found`);
    process.exit(1);
  }

  const disputed = invoices.data[0];
  console.log(`Found disputed invoice: ${disputed.id}`);
  console.log(`  Number: ${disputed.number}`);
  console.log(`  Status: ${disputed.status}`);
  console.log(`  Amount: ${(disputed.amount_due / 100).toFixed(2)} ${disputed.currency.toUpperCase()}`);
  console.log(`  Customer: ${disputed.customer}`);

  const customerId = disputed.customer as string;
  const subscriptionId = disputed.subscription as string | null;

  // Find the price — from subscription, line item, or lookup key fallback
  let priceId: string | undefined;
  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    priceId = subscription.items.data[0].price.id;
    console.log(`  Subscription: ${subscriptionId}`);
  } else if (disputed.lines.data[0]?.price?.id) {
    priceId = disputed.lines.data[0].price.id;
    console.log(`  No subscription (standalone invoice)`);
  }

  if (!priceId) {
    // Standalone invoice with no price ref — resolve from lookup key
    const prices = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true });
    if (prices.data.length === 0) {
      console.error(`No active price for lookup key: ${LOOKUP_KEY}`);
      process.exit(1);
    }
    priceId = prices.data[0].id;
    console.log(`  Resolved price from lookup key: ${LOOKUP_KEY}`);
  }
  console.log(`  Price: ${priceId}`);
  console.log(`\nWill void and reissue with PO: ${PO_NUMBER}`);

  if (dryRun) {
    console.log('\n--dry-run: Would void invoice and create corrected invoice. Exiting.');
    return;
  }

  // 2. Void the disputed invoice
  console.log('\nVoiding disputed invoice...');
  await stripe.invoices.voidInvoice(disputed.id);
  console.log('  Voided.');

  // 3. Cancel old subscription if one exists
  if (subscriptionId) {
    console.log('Canceling old subscription...');
    await stripe.subscriptions.cancel(subscriptionId);
    console.log('  Canceled.');
  }

  // 4. Create new subscription with backdated start
  const invoiceDateUnix = Math.floor(INVOICE_DATE.getTime() / 1000);

  const newSub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    collection_method: 'send_invoice',
    days_until_due: DAYS_UNTIL_DUE,
    backdate_start_date: invoiceDateUnix,
    metadata: {
      lookup_key: LOOKUP_KEY,
      note: `Corrected invoice — original ${DISPUTED_INVOICE_NUMBER} voided (missing PO)`,
    },
  });

  console.log(`\nNew subscription: ${newSub.id}`);

  // 5. Update draft invoice with PO number, dates
  const newInvoiceId = newSub.latest_invoice as string;
  const dueDateUnix = Math.floor(DUE_DATE.getTime() / 1000);

  await stripe.invoices.update(newInvoiceId, {
    effective_at: invoiceDateUnix,
    due_date: dueDateUnix,
    custom_fields: [
      { name: 'PO Number', value: PO_NUMBER },
    ],
  });

  console.log(`Draft invoice updated with PO ${PO_NUMBER}`);

  // 6. Send the corrected invoice
  const sent = await stripe.invoices.sendInvoice(newInvoiceId);

  console.log(`\nCorrected invoice sent!`);
  console.log(`  Invoice number: ${sent.number}`);
  console.log(`  Effective date: ${new Date(sent.effective_at! * 1000).toISOString().split('T')[0]}`);
  console.log(`  Due date: ${new Date(sent.due_date! * 1000).toISOString().split('T')[0]}`);
  console.log(`  Amount: ${(sent.amount_due / 100).toFixed(2)} ${sent.currency.toUpperCase()}`);
  console.log(`  URL: ${sent.hosted_invoice_url}`);
  console.log(`  PDF: ${sent.invoice_pdf}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
