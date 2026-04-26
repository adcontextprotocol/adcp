/**
 * Unwind the Triton Stripe + AAO state mix-up.
 *
 * Triton org `org_01KC80TYK2QPPWQ7A8SGGGNHE7` (Stripe customer cus_TaW7BurSnlPAOy):
 *   - Has the legitimate $10K Corporate sub `sub_1SeaQXHs54uYsO3aCPkHEY0R`,
 *     paid in full Dec 15 2025. Founding-rate that maps to today's Member tier.
 *   - Has a duplicate $3K Builder sub `sub_1TKeZpHs54uYsO3ajCqKVBS1` from
 *     Apr 10 2026 with a voided invoice (never paid). This is the ghost.
 *   - Stripe customer email/name labels it "Encypher Corporation" /
 *     `erik.svilich@encypher.com`, which leaks Encypher's contact onto a
 *     Triton receipt.
 *
 * Steps (all reversible):
 *   1. Update Stripe customer email + name to a real Triton contact.
 *   2. Cancel the duplicate Builder subscription (no proration, $0 in flight).
 *   3. Touch the Corporate subscription's metadata to fire a
 *      `customer.subscription.updated` webhook — that lands in our webhook
 *      handler at `server/src/http.ts:3450` and runs `buildSubscriptionUpdate`,
 *      which writes subscription_status / stripe_subscription_id /
 *      subscription_amount / subscription_price_lookup_key / membership_tier
 *      from the Corporate sub. No new admin endpoint needed.
 *   4. Re-fetch the org row via admin API and print the final state.
 *
 * Defaults to --dry-run. Pass --execute to actually run the writes.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... \
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/unwind-triton.ts            # dry run
 *
 *   STRIPE_SECRET_KEY=sk_live_... \
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/unwind-triton.ts --execute  # live
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL?.replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY not set');
  process.exit(1);
}

const TRITON_ORG_ID = process.env.TRITON_ORG_ID || 'org_01KC80TYK2QPPWQ7A8SGGGNHE7';
const TRITON_CUSTOMER_ID = process.env.TRITON_CUSTOMER_ID || 'cus_TaW7BurSnlPAOy';
const BUILDER_SUB_ID = process.env.BUILDER_SUB_ID || 'sub_1TKeZpHs54uYsO3ajCqKVBS1';
const CORPORATE_SUB_ID = process.env.CORPORATE_SUB_ID || 'sub_1SeaQXHs54uYsO3aCPkHEY0R';
const NEW_EMAIL = process.env.NEW_EMAIL || 'benjamin.masse@tritondigital.com';
const NEW_NAME = process.env.NEW_NAME || 'Triton Digital';

const execute = process.argv.includes('--execute');
const dryRun = !execute;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2026-03-25.dahlia' as Stripe.LatestApiVersion,
});

async function adminFetch<T = unknown>(path: string, init?: RequestInit): Promise<T | null> {
  if (!ADMIN_BASE_URL || !ADMIN_API_KEY) return null;
  const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ADMIN_API_KEY}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    console.error(`  admin API ${path}: ${res.status} ${res.statusText}`);
    return null;
  }
  return (await res.json()) as T;
}

function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return 'null';
  return `$${(cents / 100).toLocaleString()}`;
}

async function preflight() {
  console.log(`# Triton unwind — ${dryRun ? 'DRY RUN' : 'LIVE'} — ${new Date().toISOString()}\n`);
  console.log(`Stripe customer:    ${TRITON_CUSTOMER_ID}`);
  console.log(`Builder sub (kill): ${BUILDER_SUB_ID}`);
  console.log(`Corporate sub:      ${CORPORATE_SUB_ID}`);
  console.log(`New email:          ${NEW_EMAIL}`);
  console.log(`New name:           ${NEW_NAME}\n`);

  console.log('## Preflight (read-only)\n');

  const cust = await stripe.customers.retrieve(TRITON_CUSTOMER_ID);
  if ('deleted' in cust && cust.deleted) {
    console.error('Stripe customer is deleted — refusing to continue.');
    process.exit(1);
  }
  const c = cust as Stripe.Customer;
  console.log(`- customer.email = ${c.email}`);
  console.log(`- customer.name  = ${c.name}`);
  if (c.metadata?.workos_organization_id !== TRITON_ORG_ID) {
    console.error(
      `Customer metadata.workos_organization_id (${c.metadata?.workos_organization_id}) ≠ TRITON_ORG_ID (${TRITON_ORG_ID}). Refusing.`,
    );
    process.exit(1);
  }

  const builder = await stripe.subscriptions.retrieve(BUILDER_SUB_ID);
  console.log(`- builder.status = ${builder.status}, price.lookup_key = ${builder.items.data[0]?.price?.lookup_key}`);
  if (builder.status === 'canceled') {
    console.log('  _Builder sub already canceled. Skipping cancel step._');
  } else if (builder.items.data[0]?.price?.lookup_key !== 'aao_membership_builder_3000') {
    console.error(
      `Builder sub lookup_key is not aao_membership_builder_3000 — refusing to cancel.`,
    );
    process.exit(1);
  }

  const corp = await stripe.subscriptions.retrieve(CORPORATE_SUB_ID);
  console.log(`- corporate.status = ${corp.status}, price.lookup_key = ${corp.items.data[0]?.price?.lookup_key}`);
  if (corp.status !== 'active') {
    console.error(`Corporate sub status is ${corp.status} — refusing.`);
    process.exit(1);
  }
  if (corp.items.data[0]?.price?.lookup_key !== 'aao_membership_corporate_5m') {
    console.error(`Corporate sub lookup_key is not aao_membership_corporate_5m — refusing.`);
    process.exit(1);
  }
  console.log(`- corporate.amount = ${fmtCents(corp.items.data[0]?.price?.unit_amount)}/${corp.items.data[0]?.price?.recurring?.interval}\n`);

  return { customer: c, builder, corporate: corp };
}

async function reportOrgRow(label: string) {
  if (!ADMIN_BASE_URL || !ADMIN_API_KEY) {
    console.log(`  _Admin API not configured — skipping ${label}._`);
    return;
  }
  const row = await adminFetch<Record<string, unknown>>(`/api/admin/accounts/${TRITON_ORG_ID}`);
  if (!row) return;
  const fields = [
    'name',
    'membership_tier',
    'subscription_status',
    'subscription_amount',
    'subscription_interval',
    'subscription_current_period_end',
    'subscription_price_lookup_key',
    'stripe_subscription_id',
    'stripe_customer_id',
  ];
  console.log(`  ${label}:`);
  for (const f of fields) {
    const v = row[f];
    if (f === 'subscription_amount' && typeof v === 'number') {
      console.log(`    ${f}: ${fmtCents(v)}`);
    } else {
      console.log(`    ${f}: ${JSON.stringify(v)}`);
    }
  }
}

async function step1UpdateCustomer(current: Stripe.Customer) {
  console.log('## Step 1 — update Stripe customer email + name\n');
  console.log(`  before: email=${current.email} name=${current.name}`);
  console.log(`  after:  email=${NEW_EMAIL} name=${NEW_NAME}`);
  if (dryRun) {
    console.log('  _dry run — no write_\n');
    return;
  }
  const updated = await stripe.customers.update(TRITON_CUSTOMER_ID, {
    email: NEW_EMAIL,
    name: NEW_NAME,
    metadata: {
      ...current.metadata,
      contact_name: 'Benjamin Masse',
      unwound_at: new Date().toISOString(),
      unwound_reason: 'Triton/Encypher cross-contamination cleanup',
    },
  });
  console.log(`  ✓ updated: email=${updated.email} name=${updated.name}\n`);
}

async function step2CancelBuilder(builder: Stripe.Subscription) {
  console.log('## Step 2 — cancel duplicate Builder subscription\n');
  if (builder.status === 'canceled') {
    console.log('  already canceled, skipping\n');
    return;
  }
  console.log(`  ${BUILDER_SUB_ID} status=${builder.status} → cancel (no proration)`);
  if (dryRun) {
    console.log('  _dry run — no write_\n');
    return;
  }
  const canceled = await stripe.subscriptions.cancel(BUILDER_SUB_ID, {
    prorate: false,
  });
  console.log(`  ✓ canceled: status=${canceled.status} canceled_at=${canceled.canceled_at}\n`);
}

async function step3TouchCorporate(corp: Stripe.Subscription) {
  console.log('## Step 3 — touch Corporate subscription metadata to fire webhook\n');
  console.log(`  ${CORPORATE_SUB_ID} → metadata.last_admin_sync = "${new Date().toISOString()}"`);
  console.log('  This fires customer.subscription.updated → buildSubscriptionUpdate webhook,');
  console.log('  which writes membership_tier=company_icl, stripe_subscription_id, lookup_key, etc.');
  if (dryRun) {
    console.log('  _dry run — no write_\n');
    return;
  }
  await stripe.subscriptions.update(CORPORATE_SUB_ID, {
    metadata: {
      ...corp.metadata,
      last_admin_sync: new Date().toISOString(),
      last_admin_sync_reason: 'Triton unwind: refresh org row to Corporate sub state',
    },
  });
  console.log('  ✓ touched — waiting 5s for webhook delivery\n');
  await new Promise((r) => setTimeout(r, 5000));
}

async function step4ReportFinal() {
  console.log('## Step 4 — final org row state\n');
  await reportOrgRow('post-unwind org row');
  console.log('');
}

async function main() {
  const { customer, builder, corporate } = await preflight();

  console.log('## Pre-state\n');
  await reportOrgRow('current org row');
  console.log('');

  await step1UpdateCustomer(customer);
  await step2CancelBuilder(builder);
  await step3TouchCorporate(corporate);

  if (!dryRun) {
    await step4ReportFinal();
  } else {
    console.log('## Step 4 — final report (skipped in dry run)\n');
    console.log('  Re-run with --execute to perform the writes.\n');
  }

  console.log(`Done — ${dryRun ? 'DRY RUN, no changes made' : 'LIVE, all steps executed'}.`);
}

main().catch((err) => {
  console.error('Unwind failed:', err);
  process.exit(1);
});
