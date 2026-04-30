/**
 * Run the `stripe-sub-reflected-in-org-row` invariant against the local
 * sandbox state (Stripe test mode + dev DB) and print the violations.
 *
 * Use to verify that the sandbox fixtures produce the expected drift
 * detections before exercising remediation logic. Read-only — no writes.
 *
 * Usage: npx tsx server/scripts/verify-sandbox.ts
 */
import 'dotenv/config';
import Stripe from 'stripe';
import pg from 'pg';
import pino from 'pino';
import { stripeSubReflectedInOrgRowInvariant } from '../src/audit/integrity/invariants/stripe-sub-reflected-in-org-row.js';
import type { InvariantContext } from '../src/audit/integrity/types.js';

async function main(): Promise<void> {
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  if (!stripeKey.startsWith('sk_test_')) {
    console.error('REFUSING: STRIPE_SECRET_KEY must be sk_test_*');
    process.exit(1);
  }
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const logger = pino({ level: 'warn' });

  const ctx: InvariantContext = {
    pool: pool as unknown as InvariantContext['pool'],
    stripe,
    workos: null as unknown as InvariantContext['workos'], // not needed for this invariant
    logger,
  };

  console.log('Running stripe-sub-reflected-in-org-row against local sandbox + Stripe test mode...');
  const result = await stripeSubReflectedInOrgRowInvariant.check(ctx);
  console.log(`\nChecked ${result.checked} subscriptions`);
  console.log(`Violations: ${result.violations.length}`);

  // Filter to sandbox-relevant violations only (ignore any unrelated test-mode noise)
  const sandboxViolations = result.violations.filter((v) => {
    const orgName = (v.details as { org_name?: string } | undefined)?.org_name;
    if (orgName?.startsWith('AAO Sandbox')) return true;
    if (v.subject_id.includes('aao_sandbox')) return true;
    // Orphan-customer fixtures: violation subject is the customer id; check if the
    // customer has an aao_sandbox tag via the details (best-effort).
    return false;
  });

  console.log(`\n=== Sandbox-related violations: ${sandboxViolations.length} ===`);
  for (const v of result.violations) {
    const isSandbox =
      (v.details as { org_name?: string } | undefined)?.org_name?.startsWith('AAO Sandbox') ||
      v.subject_id.includes('aao_sandbox');
    if (!isSandbox) continue;
    console.log(`\n[${v.severity.toUpperCase()}] ${v.subject_type}=${v.subject_id}`);
    console.log(`  ${v.message}`);
    if (v.details?.lookup_key) console.log(`  lookup_key: ${v.details.lookup_key}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
