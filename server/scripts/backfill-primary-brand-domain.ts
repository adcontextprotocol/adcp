/**
 * Backfill `member_profiles.primary_brand_domain` from verified WorkOS domains.
 *
 * For each member_profile where `primary_brand_domain IS NULL`, find the org's
 * verified, claimable WorkOS-sourced domain and set it. Skips ambiguous cases
 * (multiple verified domains) so an admin can resolve those manually — the
 * webhook auto-populate (workos-webhooks.ts) handles the single-domain case
 * going forward; this script catches profiles created before that change
 * landed.
 *
 * Usage:
 *   npx tsx server/scripts/backfill-primary-brand-domain.ts --dry-run
 *   npx tsx server/scripts/backfill-primary-brand-domain.ts
 *
 * Prerequisites: DATABASE_URL set.
 */

import { getPool } from '../src/db/client.js';
import {
  assertClaimableBrandDomain,
  canonicalizeBrandDomain,
} from '../src/services/identifier-normalization.js';

const dryRun = process.argv.includes('--dry-run');

interface Candidate {
  org_id: string;
  domains: string[];
}

async function main(): Promise<void> {
  const pool = getPool();

  const result = await pool.query<{ workos_organization_id: string; domain: string }>(
    `SELECT mp.workos_organization_id, od.domain
       FROM member_profiles mp
       JOIN organization_domains od ON od.workos_organization_id = mp.workos_organization_id
      WHERE mp.primary_brand_domain IS NULL
        AND od.verified = true
        AND od.source = 'workos'
      ORDER BY mp.workos_organization_id, od.created_at ASC`,
  );

  const byOrg = new Map<string, string[]>();
  for (const row of result.rows) {
    const arr = byOrg.get(row.workos_organization_id) ?? [];
    arr.push(row.domain);
    byOrg.set(row.workos_organization_id, arr);
  }

  let scanned = 0;
  let setCount = 0;
  let skippedNonClaimable = 0;
  let skippedAmbiguous = 0;
  const sets: Array<{ org: string; domain: string }> = [];
  const ambiguous: Candidate[] = [];

  for (const [orgId, domains] of byOrg) {
    scanned += 1;
    const claimable = domains.filter((d) => {
      try {
        assertClaimableBrandDomain(canonicalizeBrandDomain(d));
        return true;
      } catch {
        return false;
      }
    });

    if (claimable.length === 0) {
      skippedNonClaimable += 1;
      continue;
    }
    if (claimable.length > 1) {
      skippedAmbiguous += 1;
      ambiguous.push({ org_id: orgId, domains: claimable });
      continue;
    }

    const domain = claimable[0];
    sets.push({ org: orgId, domain });

    if (!dryRun) {
      await pool.query(
        `UPDATE member_profiles
            SET primary_brand_domain = $1, updated_at = NOW()
          WHERE workos_organization_id = $2
            AND primary_brand_domain IS NULL`,
        [domain, orgId]
      );
    }
    setCount += 1;
  }

  console.log(`Scanned: ${scanned} profiles with NULL primary_brand_domain and ≥1 verified WorkOS domain`);
  console.log(`Set:     ${setCount}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`Skipped (non-claimable): ${skippedNonClaimable}`);
  console.log(`Skipped (ambiguous, ≥2 claimable): ${skippedAmbiguous}`);
  if (ambiguous.length > 0) {
    console.log('\nAmbiguous orgs needing manual resolution:');
    for (const a of ambiguous) console.log(`  ${a.org_id}: ${a.domains.join(', ')}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
