/**
 * Stage 0 of the domain-column rationalization (issue #4159, spec at
 * specs/domain-column-rationalization.md).
 *
 * Three idempotent phases that prepare the fleet for Option B (collapse
 * member_profiles.primary_brand_domain into organization_domains.is_primary).
 *
 * Phases:
 *  - canonicalize-www  Strip `www.` from member_profiles.primary_brand_domain
 *                      values where the apex equivalent already exists in
 *                      organization_domains for the same org. ~10 cases per
 *                      the 2026-05-08 survey.
 *  - per-case-fixes    Hand-tuned fixes for the 6 non-trivial divergence
 *                      cases (DanAds, iPROM, Transfon, Mission Media, Triton,
 *                      Mangrove). Each case has explicit before-state guards
 *                      so re-runs after a manual change abort instead of
 *                      stomping. Each writes both organization_domains AND
 *                      member_profiles.primary_brand_domain so the row state
 *                      is coherent post-Stage-0.
 *
 * Both phases are independently runnable. Both default to dry-run; pass
 * `--apply` to write.
 *
 * Usage:
 *   node /app/dist/scripts/stage0-domain-cleanup.js --phase=canonicalize-www
 *   node /app/dist/scripts/stage0-domain-cleanup.js --phase=canonicalize-www --apply
 *   node /app/dist/scripts/stage0-domain-cleanup.js --phase=per-case-fixes
 *   node /app/dist/scripts/stage0-domain-cleanup.js --phase=per-case-fixes --apply
 *
 * Exit codes: 0 success; 1 unrecoverable error; 2 a per-case guard rejected
 * because the row state diverges from the expected before-state.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { canonicalizeBrandDomain } from '../services/identifier-normalization.js';
import type { Pool } from 'pg';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
const phaseArg = process.argv.find((a) => a.startsWith('--phase='))?.split('=')[1];

interface PerCaseFix {
  org_id: string;
  org_name: string;
  description: string;
  // before-state guards — script aborts if any fail
  expected_brand_primary_before: string | null;
  expected_organization_domains_before?: Array<{ domain: string; is_primary: boolean; verified: boolean }>;
  // writes
  brand_primary_after: string;
  organization_domains_writes: Array<
    | { op: 'insert'; domain: string; verified: boolean; is_primary: boolean; source: string }
    | { op: 'update_primary'; domain: string; is_primary: boolean }
    | { op: 'update_verified'; domain: string; verified: boolean }
    | { op: 'delete'; domain: string }
  >;
}

const PER_CASE_FIXES: PerCaseFix[] = [
  {
    org_id: 'org_01KCJ4M0Q6WAR5QQD8SS1KQXW8',
    org_name: 'DanAds',
    description: 'International TLD: keep .se as verified non-primary, promote .com to primary',
    expected_brand_primary_before: 'danads.com',
    brand_primary_after: 'danads.com',
    organization_domains_writes: [
      { op: 'insert', domain: 'danads.com', verified: true, is_primary: true, source: 'manual' },
      { op: 'update_primary', domain: 'danads.se', is_primary: false },
    ],
  },
  {
    org_id: 'org_01KGF19Y4MXWMP82XA2FG70VMX',
    org_name: 'iPROM',
    description: 'International TLD: keep .si as verified non-primary, promote .eu to primary',
    expected_brand_primary_before: 'iprom.eu',
    brand_primary_after: 'iprom.eu',
    organization_domains_writes: [
      { op: 'insert', domain: 'iprom.eu', verified: true, is_primary: true, source: 'manual' },
      { op: 'update_primary', domain: 'iprom.si', is_primary: false },
    ],
  },
  {
    org_id: 'org_01KCBDJ1BN5HWR3J73HTCPS3TY',
    org_name: 'Transfon',
    description: 'BiddingStack is a product brand under Transfon — reset member-profile to transfon.com; BiddingStack stays as a separate brands-table row',
    expected_brand_primary_before: 'biddingstack.com',
    brand_primary_after: 'transfon.com',
    organization_domains_writes: [], // transfon.com is already primary; no org_domains change
  },
  {
    org_id: 'org_01KEVY532HYA8HXBRBSDJSTAJQ',
    org_name: 'Mission Media / Winstar',
    description: 'DBA case: insert winstarinteractive.com as primary, demote wims.com to non-primary verified',
    expected_brand_primary_before: 'winstarinteractive.com',
    brand_primary_after: 'winstarinteractive.com',
    organization_domains_writes: [
      { op: 'insert', domain: 'winstarinteractive.com', verified: true, is_primary: true, source: 'manual' },
      { op: 'update_primary', domain: 'wims.com', is_primary: false },
    ],
  },
  {
    org_id: 'org_01KC80TYK2QPPWQ7A8SGGGNHE7',
    org_name: 'Triton Digital',
    description: 'Data corruption from prior incident: verify tritondigital.com, set as primary, demote agilecompanion.com, drop www. duplicate',
    expected_brand_primary_before: 'tritondigital.com',
    brand_primary_after: 'tritondigital.com',
    organization_domains_writes: [
      { op: 'update_verified', domain: 'tritondigital.com', verified: true },
      { op: 'update_primary', domain: 'tritondigital.com', is_primary: true },
      { op: 'update_primary', domain: 'agilecompanion.com', is_primary: false },
      { op: 'delete', domain: 'www.tritondigital.com' },
    ],
  },
  {
    org_id: 'org_01KEWQT7DA1BXZXQGX1298CPZX',
    org_name: 'Mangrove Digital',
    description: 'Bug: linkedin.com was set as their brand. Reset to their actual domain',
    expected_brand_primary_before: 'linkedin.com',
    brand_primary_after: 'mangrovedigital.com.au',
    organization_domains_writes: [], // mangrovedigital.com.au is already primary; no org_domains change
  },
];

async function phaseCanonicalizeWww(pool: Pool): Promise<void> {
  console.log('=== PHASE: canonicalize-www ===');
  // Find profiles where primary_brand_domain starts with `www.` AND the apex
  // form already exists in organization_domains for the same org.
  const candidates = await pool.query<{
    workos_organization_id: string;
    org_name: string;
    current: string;
    apex: string;
    apex_in_org_domains: boolean;
  }>(`
    WITH profile_www AS (
      SELECT
        mp.workos_organization_id,
        o.name AS org_name,
        mp.primary_brand_domain AS current,
        SUBSTRING(mp.primary_brand_domain FROM 5) AS apex
      FROM member_profiles mp
      JOIN organizations o ON o.workos_organization_id = mp.workos_organization_id
      WHERE LOWER(mp.primary_brand_domain) LIKE 'www.%'
    )
    SELECT
      pw.workos_organization_id,
      pw.org_name,
      pw.current,
      pw.apex,
      EXISTS (
        SELECT 1 FROM organization_domains od
        WHERE od.workos_organization_id = pw.workos_organization_id
          AND LOWER(od.domain) = LOWER(pw.apex)
      ) AS apex_in_org_domains
    FROM profile_www pw
    ORDER BY pw.org_name
  `);

  console.log(`Candidates with www.<apex> primary_brand_domain: ${candidates.rowCount}`);
  let updated = 0;
  let skipped = 0;
  for (const r of candidates.rows) {
    const status = r.apex_in_org_domains ? 'WILL UPDATE' : 'SKIP (apex not in org_domains)';
    console.log(`  ${status}  ${r.org_name} (${r.workos_organization_id})  ${r.current} → ${r.apex}`);
    if (!r.apex_in_org_domains) {
      skipped += 1;
      continue;
    }
    if (apply) {
      await pool.query(
        `UPDATE member_profiles
            SET primary_brand_domain = $1, updated_at = NOW()
          WHERE workos_organization_id = $2 AND primary_brand_domain = $3`,
        [r.apex, r.workos_organization_id, r.current],
      );
    }
    updated += 1;
  }
  console.log(`Result: ${updated} updated${dryRun ? ' (would update)' : ''}, ${skipped} skipped`);
}

async function phasePerCaseFixes(pool: Pool): Promise<void> {
  console.log('=== PHASE: per-case-fixes ===');
  let applied = 0;
  let aborted = 0;
  let skipped = 0;

  for (const fix of PER_CASE_FIXES) {
    console.log(`\n--- ${fix.org_name} (${fix.org_id}) ---`);
    console.log(`  ${fix.description}`);

    // Read current state for guard checks.
    const profile = await pool.query<{ primary_brand_domain: string | null }>(
      `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
      [fix.org_id],
    );
    if (profile.rowCount === 0) {
      console.log(`  ABORT: no member_profile for this org`);
      aborted += 1;
      continue;
    }
    const currentBrandPrimary = profile.rows[0].primary_brand_domain;
    if (currentBrandPrimary !== fix.expected_brand_primary_before) {
      if (currentBrandPrimary === fix.brand_primary_after) {
        console.log(`  SKIP: already at after-state (primary_brand_domain=${currentBrandPrimary})`);
        skipped += 1;
        continue;
      }
      console.log(`  ABORT: expected_brand_primary_before=${fix.expected_brand_primary_before}, actual=${currentBrandPrimary}`);
      aborted += 1;
      continue;
    }

    if (apply) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT 1 FROM organizations WHERE workos_organization_id = $1 FOR UPDATE',
          [fix.org_id],
        );

        for (const w of fix.organization_domains_writes) {
          if (w.op === 'insert') {
            await client.query(
              `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
               ON CONFLICT (domain) DO UPDATE SET
                 verified = EXCLUDED.verified,
                 is_primary = EXCLUDED.is_primary,
                 source = EXCLUDED.source,
                 updated_at = NOW()`,
              [fix.org_id, w.domain, w.verified, w.is_primary, w.source],
            );
          } else if (w.op === 'update_primary') {
            await client.query(
              `UPDATE organization_domains SET is_primary = $1, updated_at = NOW()
                WHERE workos_organization_id = $2 AND domain = $3`,
              [w.is_primary, fix.org_id, w.domain],
            );
          } else if (w.op === 'update_verified') {
            await client.query(
              `UPDATE organization_domains SET verified = $1, updated_at = NOW()
                WHERE workos_organization_id = $2 AND domain = $3`,
              [w.verified, fix.org_id, w.domain],
            );
          } else if (w.op === 'delete') {
            await client.query(
              `DELETE FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
              [fix.org_id, w.domain],
            );
          }
        }

        // Update member_profiles.primary_brand_domain.
        await client.query(
          `UPDATE member_profiles
              SET primary_brand_domain = $1, updated_at = NOW()
            WHERE workos_organization_id = $2`,
          [fix.brand_primary_after, fix.org_id],
        );

        // Update organizations.email_domain to whichever org_domains row is now primary.
        await client.query(
          `UPDATE organizations
              SET email_domain = (
                SELECT domain FROM organization_domains
                WHERE workos_organization_id = $1 AND is_primary = true
                LIMIT 1
              ),
                  updated_at = NOW()
            WHERE workos_organization_id = $1`,
          [fix.org_id],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`  ${apply ? 'APPLIED' : 'WOULD APPLY'}: brand_primary ${fix.expected_brand_primary_before} → ${fix.brand_primary_after}`);
    for (const w of fix.organization_domains_writes) {
      console.log(`    ${w.op} ${w.domain}${'is_primary' in w ? ` is_primary=${w.is_primary}` : ''}${'verified' in w ? ` verified=${w.verified}` : ''}`);
    }
    applied += 1;
  }

  console.log(`\nResult: ${applied} applied${dryRun ? ' (would apply)' : ''}, ${skipped} skipped (already at after-state), ${aborted} aborted (state diverged)`);
  if (aborted > 0) process.exitCode = 2;
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  console.log(`Mode: ${dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing changes)'}`);

  // Sanity: do the expected counts during canonicalize-www match the survey?
  // We don't gate on this, just print so an operator can spot drift.

  if (phaseArg === 'canonicalize-www') {
    await phaseCanonicalizeWww(pool);
  } else if (phaseArg === 'per-case-fixes') {
    await phasePerCaseFixes(pool);
  } else {
    console.error('Pass --phase=canonicalize-www or --phase=per-case-fixes');
    process.exit(1);
  }
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (err) => {
    console.error(err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
