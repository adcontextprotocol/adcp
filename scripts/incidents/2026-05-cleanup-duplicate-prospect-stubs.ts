/**
 * Cleanup duplicate prospect-stub org rows surfaced by the
 * `unique-org-per-email-domain` invariant.
 *
 * Background — May 2026 audit: the April-20 prospect import re-ran without
 * dedup, creating a second `prospect`/0-member row for ~60 companies that
 * already had one from the December 2025 import. The duplicate is empty
 * (no stripe_customer_id, no agreement, no announcement, no subscription)
 * but clutters admin search and breaks domain-keyed automation.
 *
 * Strategy:
 *   1. Run the invariant via the admin API to get the duplicate list.
 *   2. For each pair, ONLY delete the duplicate when it's *fully empty*:
 *        - 0 organization_memberships
 *        - stripe_customer_id IS NULL
 *        - subscription_status IS NULL or 'none'
 *      i.e., a true stub. Anything richer (members, Stripe link) needs
 *      a manual merge call, not a delete — surface it and skip.
 *   3. Delete via direct SQL; there's no admin DELETE-org endpoint by
 *      design (org deletion is destructive enough that it doesn't have
 *      a normal admin surface).
 *
 * Defaults to --dry-run. Pass --execute to actually run the deletes.
 *
 * Usage:
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   DATABASE_URL=postgres://... \
 *   npx tsx scripts/incidents/2026-05-cleanup-duplicate-prospect-stubs.ts
 *
 *   # ...then with --execute once the dry-run output looks sane.
 */

import { Client } from 'pg';

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL?.replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ADMIN_BASE_URL) {
  console.error('ADMIN_BASE_URL not set (e.g. https://agenticadvertising.org)');
  process.exit(1);
}
if (!ADMIN_API_KEY) {
  console.error('ADMIN_API_KEY not set');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set — required for direct SQL deletes');
  process.exit(1);
}

const execute = process.argv.includes('--execute');
const dryRun = !execute;

interface Violation {
  invariant: string;
  severity: string;
  subject_id: string;
  message: string;
  details?: {
    email_domain?: string;
    duplicate?: {
      workos_organization_id: string;
      name: string;
      member_count: number;
      has_stripe_customer: boolean;
      has_active_subscription: boolean;
      member_status?: string;
    };
    keeper?: {
      workos_organization_id: string;
      name: string;
      member_count: number;
      has_stripe_customer: boolean;
    };
  };
}

interface InvariantRunReport {
  total_violations: number;
  violations: Violation[];
}

async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Admin: ${ADMIN_BASE_URL}\n`);

  console.log('Running unique-org-per-email-domain invariant...');
  const report = await adminGet<InvariantRunReport>(
    '/api/admin/integrity/check/unique-org-per-email-domain',
  );

  const violations = report.violations.filter(
    (v) => v.invariant === 'unique-org-per-email-domain',
  );
  console.log(`Found ${violations.length} duplicate org row(s).\n`);
  if (violations.length === 0) return;

  // Partition into deletable (truly empty) vs. needs-manual-merge.
  const deletable: Violation[] = [];
  const needsMerge: Violation[] = [];
  for (const v of violations) {
    const dup = v.details?.duplicate;
    if (!dup) {
      needsMerge.push(v);
      continue;
    }
    const isEmpty =
      dup.member_count === 0 &&
      !dup.has_stripe_customer &&
      !dup.has_active_subscription;
    if (isEmpty) {
      deletable.push(v);
    } else {
      needsMerge.push(v);
    }
  }

  console.log(`  Truly empty stubs (safe to delete): ${deletable.length}`);
  console.log(`  Non-empty duplicates (need manual merge): ${needsMerge.length}\n`);

  if (needsMerge.length > 0) {
    console.log('=== Needs manual merge (NOT touched by this script) ===');
    for (const v of needsMerge) {
      const d = v.details?.duplicate;
      const k = v.details?.keeper;
      console.log(
        `  ${d?.workos_organization_id} "${d?.name}" ` +
        `(${d?.member_count} members, stripe=${d?.has_stripe_customer}) ` +
        `→ keeper ${k?.workos_organization_id} "${k?.name}"`,
      );
    }
    console.log();
  }

  if (deletable.length === 0) {
    console.log('No empty stubs to delete.');
    return;
  }

  console.log('=== Deletable empty stubs ===');
  for (const v of deletable) {
    const d = v.details?.duplicate;
    const k = v.details?.keeper;
    console.log(
      `  DELETE ${d?.workos_organization_id} "${d?.name}" ` +
      `(domain=${v.details?.email_domain}, keeper=${k?.workos_organization_id})`,
    );
  }
  console.log();

  if (dryRun) {
    console.log('Dry run — no deletes issued. Pass --execute to delete.');
    return;
  }

  // Direct SQL delete. Uses a transaction with safety re-checks: even
  // though the invariant said the row is empty NOW, between the read and
  // the delete a member could have joined or Stripe could have linked.
  // Re-verify inside the txn before deleting so a mid-flight write isn't
  // silently dropped.
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (const v of deletable) {
      const orgId = v.details?.duplicate?.workos_organization_id;
      if (!orgId) {
        skipped++;
        continue;
      }
      try {
        await client.query('BEGIN');
        const verifyResult = await client.query<{
          mc: number;
          stripe_customer_id: string | null;
          subscription_status: string | null;
        }>(
          `SELECT
             (SELECT COUNT(*)::int FROM organization_memberships om
                WHERE om.workos_organization_id = o.workos_organization_id) AS mc,
             o.stripe_customer_id, o.subscription_status
           FROM organizations o
           WHERE o.workos_organization_id = $1
           FOR UPDATE`,
          [orgId],
        );
        const r = verifyResult.rows[0];
        if (!r) {
          console.log(`  ~ ${orgId}: no longer exists, skipping`);
          await client.query('ROLLBACK');
          skipped++;
          continue;
        }
        const stillEmpty =
          r.mc === 0 &&
          r.stripe_customer_id === null &&
          (r.subscription_status === null || r.subscription_status === 'none');
        if (!stillEmpty) {
          console.log(
            `  ~ ${orgId}: not empty anymore (mc=${r.mc}, ` +
            `stripe=${r.stripe_customer_id}, sub=${r.subscription_status}) — skipping`,
          );
          await client.query('ROLLBACK');
          skipped++;
          continue;
        }
        await client.query(
          'DELETE FROM organizations WHERE workos_organization_id = $1',
          [orgId],
        );
        await client.query('COMMIT');
        console.log(`  ✓ ${orgId} deleted`);
        deleted++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log(
          `  ✗ ${orgId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed++;
      }
    }
  } finally {
    await client.end();
  }

  console.log(
    `\nDeleted ${deleted}, skipped ${skipped}, failed ${failed}, total ${deletable.length}.`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
