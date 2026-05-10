/**
 * Unlink organizations whose `stripe_customer_id` points at a non-existent
 * or deleted Stripe customer. Same shape the `stripe-customer-resolves`
 * invariant detects, just with a remediation step. Until the integrity
 * invariants run on a schedule, this script is the way to clear the backlog
 * after a Stripe-mode swap or hand-deletion.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/unlink-stale-stripe-customers.ts          # dry-run
 *   npx tsx server/src/scripts/unlink-stale-stripe-customers.ts --apply  # write
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/unlink-stale-stripe-customers.js'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/unlink-stale-stripe-customers.js --apply'
 *
 * Prerequisites: DATABASE_URL and STRIPE_SECRET_KEY set. Make sure the key
 * matches the database environment (live key against prod DB, test key
 * against staging DB) — the integrity-invariants admin route refuses
 * mismatched runs for the same reason this script would silently corrupt
 * data on a mismatch.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { stripe } from '../billing/stripe-client.js';
import { isStripeNotFound } from '../audit/integrity/stripe-helpers.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;

interface OrgRow {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string;
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (!stripe) {
    console.error('STRIPE_SECRET_KEY is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  const result = await pool.query<OrgRow>(
    `SELECT workos_organization_id, name, stripe_customer_id
       FROM organizations
      WHERE stripe_customer_id IS NOT NULL`
  );

  const stale: Array<{ orgId: string; name: string; customerId: string; reason: 'missing' | 'deleted' }> = [];
  const transientErrors: Array<{ orgId: string; customerId: string; error: string }> = [];

  for (const row of result.rows) {
    try {
      const customer = await stripe.customers.retrieve(row.stripe_customer_id);
      if ('deleted' in customer && customer.deleted) {
        stale.push({
          orgId: row.workos_organization_id,
          name: row.name,
          customerId: row.stripe_customer_id,
          reason: 'deleted',
        });
      }
    } catch (err) {
      if (isStripeNotFound(err)) {
        stale.push({
          orgId: row.workos_organization_id,
          name: row.name,
          customerId: row.stripe_customer_id,
          reason: 'missing',
        });
      } else {
        transientErrors.push({
          orgId: row.workos_organization_id,
          customerId: row.stripe_customer_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!dryRun && stale.length > 0) {
    for (const s of stale) {
      await pool.query(
        `UPDATE organizations
            SET stripe_customer_id = NULL, updated_at = NOW()
          WHERE workos_organization_id = $1 AND stripe_customer_id = $2`,
        [s.orgId, s.customerId]
      );
    }
  }

  console.log(`Mode:     ${dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing changes)'}`);
  console.log(`Scanned:  ${result.rows.length} orgs with stripe_customer_id set`);
  console.log(`Stale:    ${stale.length}${dryRun ? ' (would unlink)' : ' (unlinked)'}`);
  console.log(`Transient errors: ${transientErrors.length}`);

  if (stale.length > 0) {
    console.log('\nStale customer IDs:');
    for (const s of stale) {
      console.log(`  ${s.orgId}  ${s.customerId}  ${s.reason}  ${s.name}`);
    }
  }
  if (transientErrors.length > 0) {
    console.log('\nTransient errors (left untouched, retry later):');
    for (const e of transientErrors) {
      console.log(`  ${e.orgId}  ${e.customerId}  ${e.error}`);
    }
  }
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
