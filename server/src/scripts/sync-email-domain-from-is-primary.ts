/**
 * Reconcile `organizations.email_domain` for orgs where the value is NULL
 * but `organization_domains.is_primary=true` already has the canonical
 * domain set.
 *
 * Default mode is null-only on purpose. The broader "any drift" audit
 * surfaces three classes:
 *
 *   1. NULL email_domain, canonical present
 *      → strictly safe to fill. Prospects that never had a WorkOS
 *      `organization.updated` webhook fire (and that migration 468 missed
 *      because they had no organization_domains rows at the time).
 *
 *   2. email_domain = `www.<canonical>` (or `<canonical>` = `www.<email_domain>`)
 *      → the Scope3 class. Fixed in-flight by PR #4459's webhook patch and
 *      Scope3 backfilled manually. Re-running this script with
 *      `--include-www-drift` covers the same pattern if another org hits it
 *      before the webhook next fires.
 *
 *   3. email_domain and canonical are completely different domains (e.g.
 *      `linkedin.com` vs `microsoft.com`, `quattroruote.it` vs `edidomus.it`).
 *      → NOT a drift bug. These are subsidiary / M&A / cross-brand cases
 *      that need per-org human review and are likely better modeled via
 *      `brands.house_domain` and `brand_domain_aliases`, possibly across
 *      separate org records. See #4448 follow-up issue.
 *
 * This script defaults to class (1) only. Pass `--include-www-drift` to
 * include class (2). Class (3) is never auto-fixed — flagged for review.
 *
 * Usage:
 *   npx tsx server/src/scripts/sync-email-domain-from-is-primary.ts                          # dry-run, nulls only
 *   npx tsx server/src/scripts/sync-email-domain-from-is-primary.ts --apply                  # apply, nulls only
 *   npx tsx server/src/scripts/sync-email-domain-from-is-primary.ts --include-www-drift      # dry-run, nulls + www drift
 *   npx tsx server/src/scripts/sync-email-domain-from-is-primary.ts --include-www-drift --apply
 *
 *   fly ssh console -a adcp-docs -C \
 *     'node /app/dist/scripts/sync-email-domain-from-is-primary.js --apply'
 *
 * Prerequisites: DATABASE_URL set.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
const includeWwwDrift = process.argv.includes('--include-www-drift');

interface DriftRow {
  workos_organization_id: string;
  org_name: string;
  current_email_domain: string | null;
  canonical_domain: string;
  drift_class: 'null' | 'www_drift' | 'mismatched';
}

function classifyDrift(current: string | null, canonical: string): DriftRow['drift_class'] {
  if (current == null || current === '') return 'null';
  const c = current.toLowerCase();
  const k = canonical.toLowerCase();
  if (c === `www.${k}` || k === `www.${c}`) return 'www_drift';
  return 'mismatched';
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  // Only non-personal orgs — personal orgs intentionally have NULL
  // email_domain (see workos-webhooks.ts:587). The canonical source is the
  // is_primary=true row in organization_domains.
  const result = await pool.query<Omit<DriftRow, 'drift_class'>>(`
    SELECT
      o.workos_organization_id,
      o.name AS org_name,
      o.email_domain AS current_email_domain,
      od.domain AS canonical_domain
    FROM organizations o
    JOIN organization_domains od
      ON od.workos_organization_id = o.workos_organization_id
     AND od.is_primary = true
    WHERE o.is_personal = false
      AND LOWER(COALESCE(o.email_domain, '')) != LOWER(od.domain)
    ORDER BY o.name
  `);

  const classified: DriftRow[] = result.rows.map((r) => ({
    ...r,
    drift_class: classifyDrift(r.current_email_domain, r.canonical_domain),
  }));

  const groups = {
    null: classified.filter((r) => r.drift_class === 'null'),
    www_drift: classified.filter((r) => r.drift_class === 'www_drift'),
    mismatched: classified.filter((r) => r.drift_class === 'mismatched'),
  };

  console.log(`=== email_domain reconciliation (#4448 follow-up) ===`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'} | include-www-drift: ${includeWwwDrift}`);
  console.log(`Total drifted (non-personal): ${classified.length}`);
  console.log(`  null              (fillable)            : ${groups.null.length}`);
  console.log(`  www_drift         (Scope3 class)        : ${groups.www_drift.length}`);
  console.log(`  mismatched        (M&A / subsidiary)    : ${groups.mismatched.length}\n`);

  const toFix: DriftRow[] = [...groups.null, ...(includeWwwDrift ? groups.www_drift : [])];

  for (const row of toFix) {
    console.log(
      `  [${row.drift_class}] ${row.org_name} [${row.workos_organization_id}]`
      + ` email_domain=${row.current_email_domain ?? '-'} → canonical=${row.canonical_domain}`,
    );
    if (!dryRun) {
      await pool.query(
        `UPDATE organizations SET email_domain = $1, updated_at = NOW()
         WHERE workos_organization_id = $2`,
        [row.canonical_domain, row.workos_organization_id],
      );
    }
  }

  if (groups.mismatched.length > 0) {
    console.log('\n--- mismatched (NEVER auto-fixed; needs human review) ---');
    for (const row of groups.mismatched) {
      console.log(
        `  ${row.org_name} [${row.workos_organization_id}]`
        + ` email_domain=${row.current_email_domain ?? '-'} canonical=${row.canonical_domain}`,
      );
    }
    console.log('\nThese are likely subsidiary/M&A cases. Model via `brands.house_domain` +'
              + ' `brand_domain_aliases` and (where appropriate) separate org records, rather than'
              + ' overwriting email_domain. See the #4448 follow-up issue.');
  }

  if (toFix.length === 0) {
    console.log('Nothing to apply in the current class selection.');
  } else if (dryRun) {
    console.log(`\nDRY-RUN — nothing written. ${toFix.length} row(s) ready for --apply.`);
  } else {
    console.log(`\nApplied ${toFix.length} fix(es). Future webhook fires preserve via the syncOrganizationDomains patch.`);
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error('sync-email-domain failed:', err);
  process.exit(1);
});
