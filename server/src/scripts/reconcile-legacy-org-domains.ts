/**
 * One-shot reconciliation for legacy corporate orgs that have
 * `organizations.email_domain` populated but no
 * `organization_domains.verified = true` row.
 *
 * PR #4648 hardened the agent-hostname gate by dropping the
 * `email_domain` soft-pass fallback (the column is writable from an
 * unverified WorkOS-domain webhook, so trusting it was the same shape
 * as the original escalation-#340 attack). Most orgs are unaffected:
 *
 *   - New corporate signups: bootstrap path seeds `verified=true`
 *     automatically (organization-bootstrap.ts → linkDomain).
 *   - Personal / free-email workspaces: correctly blocked.
 *   - Existing agent entries: grandfathered (gate fires only on NEW
 *     registrations / visibility flips).
 *
 * The cliff: legacy corporate orgs where `email_domain` was populated
 * via migration 481 (or by `organization.updated` webhook before the
 * `linkDomain(verified: true)` path existed) but no verified-domain
 * row was ever seeded. Those orgs were "working" pre-#4648 because the
 * old soft-pass fallback consulted `email_domain`; they now hard-fail
 * on agent registration.
 *
 * Auto-seed predicate (tightened per round-1 security review):
 *   - All active org memberships have email addresses at the org's
 *     `email_domain`. ANY-match was too loose — a consultant from
 *     another company in an unrelated org would have triggered an
 *     unintended brand-displacement (seed verified=true for THEIR
 *     domain on an org that isn't theirs). ALL-match means the org's
 *     entire human roster is at that domain, which is the strongest
 *     "this org represents this domain" signal we can read without
 *     DNS proof.
 *   - email_domain is not on the free-email-provider or shared-platform
 *     block list (gmail.com, vercel.app, substack.com, etc.). Mirrors
 *     migration 481's expanded exclusion via `SHARED_PLATFORM_DOMAINS`
 *     from identifier-normalization.ts.
 *
 * Orgs that don't pass auto-seed are flagged for manual review. The
 * intended manual path is the cross-org admin agent-removal /
 * registration endpoint added in #4498.
 *
 * On auto-seed:
 *   - INSERT organization_domains with verified=true, is_primary=true,
 *     source='reconcile_4648'. is_primary=true matches the
 *     bootstrap-path shape (linkDomain isPrimary: true) so the
 *     documented `organizations.email_domain` ↔
 *     `organization_domains.is_primary=true` invariant from migration
 *     066 holds.
 *   - Audit-log the seed via OrganizationDatabase.recordAuditLog so the
 *     source='reconcile_4648' writes are traceable in incident review.
 *
 * Note on the membership trust signal: organization_memberships.email
 * is a denormalized copy of users.email (migration 476). Source of
 * truth is users.email, but the denorm is what WorkOS webhooks write
 * at invite time and what the auto-link paths key off. Stale rows can
 * still legitimately attest "real human at this domain joined."
 *
 * Usage (dev):
 *   DATABASE_URL=… npx tsx server/src/scripts/reconcile-legacy-org-domains.ts            # dry-run
 *   DATABASE_URL=… npx tsx server/src/scripts/reconcile-legacy-org-domains.ts --apply    # write
 *
 * Usage (prod):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reconcile-legacy-org-domains.js'           # dry-run
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reconcile-legacy-org-domains.js --apply'   # write
 *
 * Closes #4672.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { isFreeEmailDomain } from '../utils/email-domain.js';
import { SHARED_PLATFORM_DOMAINS } from '../services/identifier-normalization.js';
import { OrganizationDatabase } from '../db/organization-db.js';

interface LegacyOrgRow {
  workos_organization_id: string;
  name: string;
  email_domain: string;
  active_member_count: number;
  matching_member_count: number;
  created_at: Date;
}

interface Categorized {
  auto_seed: LegacyOrgRow[];
  excluded_provider_skip: LegacyOrgRow[];
  not_all_members_match_skip: LegacyOrgRow[];
  no_members_skip: LegacyOrgRow[];
}

function isExcludedDomain(domain: string): boolean {
  const lc = domain.toLowerCase();
  if (isFreeEmailDomain(lc)) return true;
  if (SHARED_PLATFORM_DOMAINS.has(lc)) return true;
  return false;
}

function categorize(rows: LegacyOrgRow[]): Categorized {
  const result: Categorized = {
    auto_seed: [],
    excluded_provider_skip: [],
    not_all_members_match_skip: [],
    no_members_skip: [],
  };
  for (const row of rows) {
    if (isExcludedDomain(row.email_domain)) {
      result.excluded_provider_skip.push(row);
      continue;
    }
    if (row.active_member_count === 0) {
      result.no_members_skip.push(row);
      continue;
    }
    if (row.matching_member_count !== row.active_member_count) {
      result.not_all_members_match_skip.push(row);
      continue;
    }
    result.auto_seed.push(row);
  }
  return result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();
  const orgDb = new OrganizationDatabase();

  console.log(`=== legacy-org domain reconciliation (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const result = await pool.query<LegacyOrgRow>(`
    WITH legacy_orgs AS (
      SELECT
        o.workos_organization_id,
        o.name,
        LOWER(o.email_domain) AS email_domain,
        o.created_at
      FROM organizations o
      WHERE o.email_domain IS NOT NULL
        AND o.email_domain != ''
        AND o.is_personal IS NOT TRUE
        AND NOT EXISTS (
          SELECT 1 FROM organization_domains od
          WHERE od.workos_organization_id = o.workos_organization_id
            AND od.verified = true
        )
    )
    SELECT
      lo.workos_organization_id,
      lo.name,
      lo.email_domain,
      COALESCE(membership_counts.active_member_count, 0)::int AS active_member_count,
      COALESCE(membership_counts.matching_member_count, 0)::int AS matching_member_count,
      lo.created_at
    FROM legacy_orgs lo
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS active_member_count,
        COUNT(*) FILTER (
          WHERE LOWER(SPLIT_PART(om.email, '@', 2)) = lo.email_domain
        )::int AS matching_member_count
      FROM organization_memberships om
      WHERE om.workos_organization_id = lo.workos_organization_id
        AND om.email IS NOT NULL
        AND om.email != ''
    ) membership_counts ON true
    ORDER BY lo.created_at
  `);

  const rows = result.rows;
  console.log(`Legacy orgs (no verified-domain row, email_domain set, not personal): ${rows.length}`);
  if (rows.length === 0) {
    console.log('Nothing to reconcile.');
    await closeDatabase();
    return;
  }

  const cat = categorize(rows);
  console.log(`  auto_seed candidates (ALL members at email_domain): ${cat.auto_seed.length}`);
  console.log(`  not-all-members-match (mixed-domain rosters):       ${cat.not_all_members_match_skip.length}`);
  console.log(`  no-members on the org row:                          ${cat.no_members_skip.length}`);
  console.log(`  excluded-provider skip (free email / shared host):  ${cat.excluded_provider_skip.length}`);

  if (cat.auto_seed.length > 0) {
    console.log('\nAuto-seed candidates:');
    for (const r of cat.auto_seed) {
      console.log(
        `  ${r.workos_organization_id}  ${r.email_domain.padEnd(40)} ${r.matching_member_count}/${r.active_member_count}  "${r.name}"`
      );
    }
  }
  if (cat.not_all_members_match_skip.length > 0) {
    console.log('\nMixed-domain roster (FLAG FOR OPS REVIEW — only some members at email_domain):');
    for (const r of cat.not_all_members_match_skip) {
      console.log(
        `  ${r.workos_organization_id}  ${r.email_domain.padEnd(40)} ${r.matching_member_count}/${r.active_member_count}  "${r.name}"`
      );
    }
  }
  if (cat.no_members_skip.length > 0) {
    console.log('\nNo-members orgs (FLAG FOR OPS REVIEW — empty roster, cannot validate claim):');
    for (const r of cat.no_members_skip) {
      console.log(`  ${r.workos_organization_id}  ${r.email_domain.padEnd(40)} "${r.name}"`);
    }
  }
  if (cat.excluded_provider_skip.length > 0) {
    console.log('\nFree-email / shared-platform skip (cannot stake a domain claim):');
    for (const r of cat.excluded_provider_skip) {
      console.log(`  ${r.workos_organization_id}  ${r.email_domain.padEnd(40)} "${r.name}"`);
    }
  }

  if (!apply) {
    console.log('\nDRY-RUN -- pass --apply to seed verified-domain rows for the auto-seed group.');
    await closeDatabase();
    return;
  }

  if (cat.auto_seed.length === 0) {
    console.log('\nNo auto-seed candidates; nothing to write.');
    await closeDatabase();
    return;
  }

  console.log(`\nApplying ${cat.auto_seed.length} verified-domain seed(s)...`);
  let seeded = 0;
  let conflicted = 0;
  for (const r of cat.auto_seed) {
    // ON CONFLICT (domain) DO NOTHING — if another org already owns
    // this domain in organization_domains, we leave it alone. The
    // legacy org will still hard-reject on agent registration, but ops
    // can resolve the conflict manually. is_primary=true matches the
    // bootstrap-path shape (linkDomain isPrimary: true) so
    // `organizations.email_domain` and
    // `organization_domains.is_primary=true` stay in sync (migration
    // 066's documented invariant).
    const insert = await pool.query<{ workos_organization_id: string }>(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'reconcile_4648', NOW(), NOW())
       ON CONFLICT (domain) DO NOTHING
       RETURNING workos_organization_id`,
      [r.workos_organization_id, r.email_domain],
    );
    if (insert.rowCount && insert.rowCount > 0) {
      seeded++;
      console.log(`  + seeded ${r.workos_organization_id} <- ${r.email_domain}`);
      // Audit-log so the source='reconcile_4648' write is traceable
      // in incident review. Best-effort; never block on audit-log
      // failure (the source-column tag is the load-bearing trace).
      try {
        await orgDb.recordAuditLog({
          workos_organization_id: r.workos_organization_id,
          workos_user_id: 'reconcile_4648_script',
          action: 'organization_domain_seeded',
          resource_type: 'organization_domain',
          resource_id: r.email_domain,
          details: {
            source: 'reconcile_4648',
            verified: true,
            is_primary: true,
            matching_member_count: r.matching_member_count,
            active_member_count: r.active_member_count,
            issue: 'https://github.com/adcontextprotocol/adcp/issues/4672',
          },
        });
      } catch (err) {
        console.log(`    ! audit-log write failed (non-fatal): ${(err as Error).message}`);
      }
    } else {
      conflicted++;
      console.log(`  - skipped ${r.workos_organization_id} <- ${r.email_domain} (domain already owned by another org)`);
    }
  }
  const totalFlagged =
    cat.not_all_members_match_skip.length + cat.no_members_skip.length;
  console.log(`\nDone. seeded=${seeded}, conflicted=${conflicted}, flagged_for_review=${totalFlagged}`);
  await closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
