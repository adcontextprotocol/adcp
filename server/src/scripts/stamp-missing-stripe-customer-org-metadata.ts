/**
 * Stamp missing `metadata.workos_organization_id` on Stripe customers already
 * linked from `organizations.stripe_customer_id`.
 *
 * This remediates the safe half of the
 * `stripe-customer-org-metadata-bidirectional` invariant: DB says org A owns
 * customer C, and Stripe customer C has no org metadata at all. The script
 * does not overwrite customers whose metadata points to a different org; those
 * remain conflict cases for an admin to inspect.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/stamp-missing-stripe-customer-org-metadata.ts
 *   npx tsx server/src/scripts/stamp-missing-stripe-customer-org-metadata.ts --apply
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/stamp-missing-stripe-customer-org-metadata.js'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/stamp-missing-stripe-customer-org-metadata.js --apply'
 *
 * Prerequisites: DATABASE_URL and STRIPE_SECRET_KEY set for the same
 * environment.
 */

import type Stripe from 'stripe';
import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { stripe } from '../billing/stripe-client.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
const LIVE_SUBS = new Set(['active', 'trialing', 'past_due']);

interface OrgRow {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string;
}

interface MissingMetadata {
  orgId: string;
  name: string;
  customerId: string;
  customerEmail: string | null;
}

interface Conflict {
  orgId: string;
  name: string;
  customerId: string;
  metadataOrgId: string;
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
      WHERE stripe_customer_id IS NOT NULL
      ORDER BY workos_organization_id`,
  );

  const missing: MissingMetadata[] = [];
  const conflicts: Conflict[] = [];
  const deleted: MissingMetadata[] = [];
  const transientErrors: Array<{ orgId: string; customerId: string; error: string }> = [];

  for (const row of result.rows) {
    try {
      const customer = await stripe.customers.retrieve(row.stripe_customer_id);
      if ('deleted' in customer && customer.deleted) {
        deleted.push({
          orgId: row.workos_organization_id,
          name: row.name,
          customerId: row.stripe_customer_id,
          customerEmail: null,
        });
        continue;
      }

      const liveCustomer = customer as Stripe.Customer;
      const stampedOrgId = liveCustomer.metadata?.workos_organization_id ?? null;
      if (stampedOrgId === row.workos_organization_id) {
        continue;
      }
      if (stampedOrgId) {
        conflicts.push({
          orgId: row.workos_organization_id,
          name: row.name,
          customerId: row.stripe_customer_id,
          metadataOrgId: stampedOrgId,
        });
        continue;
      }

      const subscriptions = await stripe.subscriptions.list({
        customer: row.stripe_customer_id,
        status: 'all',
        limit: 100,
      });
      const conflictingLiveSub = subscriptions.data.find((sub) => {
        const subOrgId = sub.metadata?.workos_organization_id;
        return Boolean(
          LIVE_SUBS.has(sub.status) &&
          subOrgId &&
          subOrgId !== row.workos_organization_id,
        );
      });
      if (conflictingLiveSub?.metadata?.workos_organization_id) {
        conflicts.push({
          orgId: row.workos_organization_id,
          name: row.name,
          customerId: row.stripe_customer_id,
          metadataOrgId: conflictingLiveSub.metadata.workos_organization_id,
        });
        continue;
      }

      missing.push({
        orgId: row.workos_organization_id,
        name: row.name,
        customerId: row.stripe_customer_id,
        customerEmail: liveCustomer.email ?? null,
      });
    } catch (err) {
      transientErrors.push({
        orgId: row.workos_organization_id,
        customerId: row.stripe_customer_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!dryRun) {
    for (const item of missing) {
      await stripe.customers.update(item.customerId, {
        metadata: { workos_organization_id: item.orgId },
      });
    }
  }

  console.log(`Mode:       ${dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing Stripe metadata)'}`);
  console.log(`Scanned:    ${result.rows.length} orgs with stripe_customer_id set`);
  console.log(`Missing:    ${missing.length}${dryRun ? ' (would stamp)' : ' (stamped)'}`);
  console.log(`Conflicts:  ${conflicts.length} (left untouched)`);
  console.log(`Deleted:    ${deleted.length} (left untouched)`);
  console.log(`Errors:     ${transientErrors.length}`);

  if (missing.length > 0) {
    console.log('\nMissing metadata:');
    for (const item of missing) {
      console.log(`  ${item.orgId}  ${item.customerId}  ${item.customerEmail ?? 'no-email'}  ${item.name}`);
    }
  }
  if (conflicts.length > 0) {
    console.log('\nConflicts (manual review required):');
    for (const item of conflicts) {
      console.log(`  ${item.orgId}  ${item.customerId}  metadata=${item.metadataOrgId}  ${item.name}`);
    }
  }
  if (deleted.length > 0) {
    console.log('\nDeleted customers (use unlink-stale-stripe-customers if appropriate):');
    for (const item of deleted) {
      console.log(`  ${item.orgId}  ${item.customerId}  ${item.name}`);
    }
  }
  if (transientErrors.length > 0) {
    console.log('\nTransient errors (left untouched, retry later):');
    for (const item of transientErrors) {
      console.log(`  ${item.orgId}  ${item.customerId}  ${item.error}`);
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
