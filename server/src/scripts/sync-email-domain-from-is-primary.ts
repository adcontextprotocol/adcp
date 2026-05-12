/**
 * Reconcile `organizations.email_domain` for orgs where the value drifted
 * away from `organization_domains.is_primary=true`.
 *
 * Root cause (pre-#4448 follow-up): the WorkOS `organization.updated`
 * webhook handler sourced `email_domain` from `org.domains[0]`. WorkOS
 * array order is not stable, so orgs with a verified root + a `failed`
 * www variant could have WorkOS list www first, overwriting `email_domain`
 * to the wrong value on every webhook fire even when our table's
 * `is_primary` row was correct.
 *
 * Scope3 was the known case: `organizations.email_domain='www.scope3.com'`
 * while `organization_domains.is_primary=true` was on `scope3.com`. Caused
 * downstream lookups (e.g. `services/brand-enrichment.ts`'s
 * `WHERE email_domain = $1`) to miss the org row entirely.
 *
 * The webhook itself is now fixed (see `routes/workos-webhooks.ts`
 * `syncOrganizationDomains`) — it reads `email_domain` from
 * `organization_domains.is_primary=true` directly. This script clears the
 * pre-fix backlog.
 *
 * Usage:
 *   npx tsx server/src/scripts/sync-email-domain-from-is-primary.ts            # dry-run
 *   npx tsx server/src/scripts/sync-email-domain-from-is-primary.ts --apply    # write
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

interface DriftRow {
  workos_organization_id: string;
  org_name: string;
  current_email_domain: string | null;
  canonical_domain: string;
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
  const result = await pool.query<DriftRow>(`
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

  console.log(`=== email_domain drift reconciliation (#4448 follow-up) ===`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes; pass --apply to persist)' : 'APPLY'}`);
  console.log(`Drifted orgs: ${result.rowCount}\n`);

  if (result.rowCount === 0) {
    console.log('No drift detected — done.');
    await closeDatabase();
    return;
  }

  for (const row of result.rows) {
    console.log(
      `  ${row.org_name} [${row.workos_organization_id}]`
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

  if (dryRun) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply to fix.');
  } else {
    console.log('\nApplied. Future webhook fires preserve via the fix to syncOrganizationDomains.');
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error('sync-email-domain failed:', err);
  process.exit(1);
});
