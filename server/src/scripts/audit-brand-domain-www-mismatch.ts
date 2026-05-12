/**
 * Audit orgs whose past `brand_revisions` were written against a different
 * brand domain than their current `organization_domains.is_primary=true` row.
 * Filed as #4448 — Stage 2 of #4159 (drop of `member_profiles.primary_brand_domain`)
 * moved the publish path's brand-row authority from the dropped column to the
 * resolver, and orgs whose dropped column held `www.<domain>` while their
 * verified org-domain is `<domain>` (or vice versa) now publish manifest
 * updates against a brand row they have not previously curated.
 *
 * Output is one row per (org, revision_domain) pair. The script does not
 * write — it is a dry-run audit feeding a backfill decision.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/audit-brand-domain-www-mismatch.ts
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/audit-brand-domain-www-mismatch.js'
 *
 * Prerequisites: DATABASE_URL set.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';

interface MismatchRow {
  org_id: string;
  org_name: string;
  org_email_domain: string | null;
  primary_domain: string;
  revision_domain: string;
  revision_count: number;
  last_revision_at: Date;
  /**
   * `manifest_orphaned` flag on the brand row at `revision_domain`. True
   * means a prior reconciliation moved content off this row; the historical
   * revisions remain (the table is a permanent log) but the row no longer
   * serves the manifest. Use this column to distinguish "needs fix" from
   * "already reconciled" — the audit-row presence alone is not enough.
   */
  revision_row_orphaned: boolean | null;
  mismatch_kind: 'www_in_revisions' | 'www_in_primary' | 'unrelated';
}

function classifyMismatch(primary: string, revision: string): MismatchRow['mismatch_kind'] {
  const p = primary.toLowerCase();
  const r = revision.toLowerCase();
  if (r === `www.${p}`) return 'www_in_revisions';
  if (p === `www.${r}`) return 'www_in_primary';
  return 'unrelated';
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  const result = await pool.query<MismatchRow>(`
    WITH org_brand_edits AS (
      -- One row per (org, brand-domain-edited). Editor → org via membership.
      -- DISTINCT collapses the per-revision rows; count is recomputed below.
      SELECT
        om.workos_organization_id AS org_id,
        br.domain AS revision_domain,
        COUNT(*)::int AS revision_count,
        MAX(br.created_at) AS last_revision_at
      FROM brand_revisions br
      JOIN organization_memberships om
        ON om.workos_user_id = br.editor_user_id
      WHERE br.is_rollback = false
      GROUP BY om.workos_organization_id, br.domain
    ),
    org_primary AS (
      SELECT
        workos_organization_id AS org_id,
        domain AS primary_domain
      FROM organization_domains
      WHERE is_primary = true
    )
    SELECT
      obe.org_id,
      o.name AS org_name,
      o.email_domain AS org_email_domain,
      op.primary_domain,
      obe.revision_domain,
      obe.revision_count,
      obe.last_revision_at,
      b.manifest_orphaned AS revision_row_orphaned,
      'placeholder'::text AS mismatch_kind
    FROM org_brand_edits obe
    JOIN org_primary op USING (org_id)
    JOIN organizations o ON o.workos_organization_id = obe.org_id
    LEFT JOIN brands b ON b.domain = obe.revision_domain
    WHERE lower(obe.revision_domain) != lower(op.primary_domain)
    ORDER BY o.name, obe.last_revision_at DESC
  `);

  const wwwInRevisions: MismatchRow[] = [];
  const wwwInPrimary: MismatchRow[] = [];
  const unrelated: MismatchRow[] = [];

  for (const row of result.rows) {
    const kind = classifyMismatch(row.primary_domain, row.revision_domain);
    const enriched = { ...row, mismatch_kind: kind };
    if (kind === 'www_in_revisions') wwwInRevisions.push(enriched);
    else if (kind === 'www_in_primary') wwwInPrimary.push(enriched);
    else unrelated.push(enriched);
  }

  console.log('=== Brand-domain www/no-www mismatch audit (#4448) ===\n');
  console.log(`Total mismatched (org, revision_domain) pairs: ${result.rows.length}`);
  console.log(`  www_in_revisions  (revisions on www.<domain>, primary is <domain>): ${wwwInRevisions.length}`);
  console.log(`  www_in_primary    (revisions on <domain>, primary is www.<domain>): ${wwwInPrimary.length}`);
  console.log(`  unrelated         (revisions on a different brand domain entirely): ${unrelated.length}\n`);

  const printGroup = (label: string, rows: MismatchRow[]) => {
    if (rows.length === 0) return;
    console.log(`--- ${label} (${rows.length}) ---`);
    for (const r of rows) {
      const last = r.last_revision_at instanceof Date
        ? r.last_revision_at.toISOString()
        : String(r.last_revision_at);
      const reconciled = r.revision_row_orphaned ? ' [RECONCILED — www row orphaned]' : '';
      console.log(
        `  ${r.org_name} [${r.org_id}] email_domain=${r.org_email_domain ?? '-'}`
        + ` primary=${r.primary_domain} revisions_on=${r.revision_domain}`
        + ` count=${r.revision_count} last=${last}${reconciled}`,
      );
    }
    console.log('');
  };

  printGroup('www_in_revisions (publish drift on next publish)', wwwInRevisions);
  printGroup('www_in_primary', wwwInPrimary);
  printGroup('unrelated brand-domain edits', unrelated);

  await closeDatabase();
}

main().catch((err) => {
  console.error('audit failed:', err);
  process.exit(1);
});
