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
 * Trust signal for auto-seed: an org has at least one
 * `organization_memberships` row whose email's domain matches the
 * org's `email_domain`. If a real human at that domain is a member of
 * the org, the email_domain represents an actual corporate signup —
 * not a brand-claim-issue webhook writeback. Free-email-provider
 * email_domain values are excluded outright.
 *
 * Orgs that don't pass auto-seed (no member at the email_domain, OR
 * free-email-provider email_domain) are flagged for manual review.
 * The intended manual path is the cross-org admin agent-removal /
 * registration endpoint added in #4498.
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

interface LegacyOrgRow {
  workos_organization_id: string;
  name: string;
  email_domain: string;
  member_at_email_domain_count: number;
  created_at: Date;
}

interface Categorized {
  auto_seed: LegacyOrgRow[];
  free_email_skip: LegacyOrgRow[];
  no_member_match_skip: LegacyOrgRow[];
}

function categorize(rows: LegacyOrgRow[]): Categorized {
  const result: Categorized = {
    auto_seed: [],
    free_email_skip: [],
    no_member_match_skip: [],
  };
  for (const row of rows) {
    if (isFreeEmailDomain(row.email_domain)) {
      result.free_email_skip.push(row);
      continue;
    }
    if (row.member_at_email_domain_count === 0) {
      result.no_member_match_skip.push(row);
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

  console.log(apply ? '🟢 Mode: APPLY' : '🔵 Mode: DRY-RUN');

  const result = await pool.query<LegacyOrgRow>(`
    SELECT
      o.workos_organization_id,
      o.name,
      LOWER(o.email_domain) AS email_domain,
      COALESCE((
        SELECT COUNT(*)::int
        FROM organization_memberships om
        WHERE om.workos_organization_id = o.workos_organization_id
          AND LOWER(SPLIT_PART(om.email, '@', 2)) = LOWER(o.email_domain)
      ), 0) AS member_at_email_domain_count,
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
    ORDER BY o.created_at
  `);

  const rows = result.rows;
  console.log(`\nLegacy orgs (no verified-domain row, email_domain set, not personal): ${rows.length}`);
  if (rows.length === 0) {
    console.log('Nothing to reconcile.');
    await closeDatabase();
    return;
  }

  const cat = categorize(rows);
  console.log(`  auto_seed candidates:     ${cat.auto_seed.length}`);
  console.log(`  free_email skip:          ${cat.free_email_skip.length}`);
  console.log(`  no member match skip:     ${cat.no_member_match_skip.length}`);

  if (cat.auto_seed.length > 0) {
    console.log('\nAuto-seed candidates (have a member at email_domain, corporate):');
    for (const r of cat.auto_seed) {
      console.log(`  ${r.workos_organization_id}  ${r.email_domain.padEnd(40)} "${r.name}"`);
    }
  }
  if (cat.no_member_match_skip.length > 0) {
    console.log('\nNo-member-match (FLAG FOR OPS REVIEW — possible brand-claim writeback):');
    for (const r of cat.no_member_match_skip) {
      console.log(`  ${r.workos_organization_id}  ${r.email_domain.padEnd(40)} "${r.name}"`);
    }
  }
  if (cat.free_email_skip.length > 0) {
    console.log('\nFree-email-provider skip (cannot stake a domain claim):');
    for (const r of cat.free_email_skip) {
      console.log(`  ${r.workos_organization_id}  ${r.email_domain.padEnd(40)} "${r.name}"`);
    }
  }

  if (!apply) {
    console.log('\nDRY-RUN — pass --apply to seed verified-domain rows for the auto-seed group.');
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
    // this domain in organization_domains, we leave it alone and skip.
    // The org will still hard-reject on agent registration, but ops
    // can resolve the conflict manually.
    const insert = await pool.query<{ workos_organization_id: string }>(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, verified, source, created_at, updated_at)
       VALUES ($1, $2, true, 'reconcile_4648', NOW(), NOW())
       ON CONFLICT (domain) DO NOTHING
       RETURNING workos_organization_id`,
      [r.workos_organization_id, r.email_domain],
    );
    if (insert.rowCount && insert.rowCount > 0) {
      seeded++;
      console.log(`  ✓ seeded ${r.workos_organization_id} ← ${r.email_domain}`);
    } else {
      conflicted++;
      console.log(`  ✗ skipped ${r.workos_organization_id} ← ${r.email_domain} (domain already owned by another org)`);
    }
  }
  console.log(`\nDone. seeded=${seeded}, conflicted=${conflicted}, flagged_for_review=${cat.no_member_match_skip.length}`);
  await closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
