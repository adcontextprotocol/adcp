/**
 * Classify brand rows verified before `domain_verification_method` was
 * recorded (#8768).
 *
 * Each candidate is a brand row with `domain_verified = true`, an owning
 * organization, and no method. For each, the script reads the organization's
 * domains from WorkOS and resolves the method the way the webhook now does:
 *
 *   - `dns`: WorkOS verified the domain by DNS. Stays verified.
 *   - `member_email`: WorkOS `manual`, and a member has a verified email on the
 *     domain. Stays verified.
 *   - `manual`: WorkOS `manual` and nothing else. An administrator's assertion,
 *     so the row stays linked to the organization but loses `domain_verified`.
 *
 * Rows whose domain is not a verified domain of the organization in WorkOS
 * (for example, verified by a brand.json pointer) are listed and left alone.
 *
 * --apply writes through BrandDatabase.syncBrandDomainFromWorkos, the same
 * path as the WorkOS webhooks, with `reclassifyLegacy`. Routine syncs leave
 * these rows alone, so this script is the only thing that demotes them.
 *
 * Usage (dev):
 *   DATABASE_URL=… WORKOS_API_KEY=… npx tsx server/src/scripts/reclassify-brand-domain-verification.ts            # dry-run
 *   DATABASE_URL=… WORKOS_API_KEY=… npx tsx server/src/scripts/reclassify-brand-domain-verification.ts --apply    # write
 *
 * Usage (prod):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reclassify-brand-domain-verification.js'           # dry-run
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reclassify-brand-domain-verification.js --apply'   # write
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { getWorkos } from '../auth/workos-client.js';
import { BrandDatabase, workosDomainVerificationStrategy, type WorkosDomainVerificationStrategy } from '../db/brand-db.js';
import { canonicalizeBrandDomain } from '../services/identifier-normalization.js';
import type { DomainVerificationMethod } from '../types.js';

interface Candidate {
  domain: string;
  workos_organization_id: string;
  org_name: string | null;
}

interface Classified extends Candidate {
  strategy: WorkosDomainVerificationStrategy;
  method: DomainVerificationMethod;
}

const WORKOS_CONCURRENCY = 10;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const brandDb = new BrandDatabase();
  const workos = getWorkos();

  console.log(`=== brand domain verification reclassification (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const candidates = (await getPool().query<Candidate>(
    `SELECT b.domain, b.workos_organization_id, o.name AS org_name
     FROM brands b
     LEFT JOIN organizations o ON o.workos_organization_id = b.workos_organization_id
     WHERE b.domain_verified = TRUE
       AND b.workos_organization_id IS NOT NULL
       AND b.domain_verification_method IS NULL
     ORDER BY b.domain`,
  )).rows;
  console.log(`Candidates: ${candidates.length}`);

  const byOrg = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const rows = byOrg.get(candidate.workos_organization_id) ?? [];
    rows.push(candidate);
    byOrg.set(candidate.workos_organization_id, rows);
  }

  const classified: Classified[] = [];
  const notVerifiedInWorkos: Candidate[] = [];
  const failures: Array<{ orgId: string; error: string }> = [];
  const orgIds = [...byOrg.keys()];

  for (let i = 0; i < orgIds.length; i += WORKOS_CONCURRENCY) {
    await Promise.all(orgIds.slice(i, i + WORKOS_CONCURRENCY).map(async (orgId) => {
      try {
        const org = await workos.organizations.getOrganization(orgId);
        for (const candidate of byOrg.get(orgId)!) {
          const workosDomain = org.domains.find(d =>
            canonicalizeBrandDomain(d.domain) === candidate.domain
            && (d.state === 'verified' || String(d.state) === 'legacy_verified'));
          if (!workosDomain) {
            notVerifiedInWorkos.push(candidate);
            continue;
          }
          const strategy = workosDomainVerificationStrategy(workosDomain.verificationStrategy);
          const method = await brandDb.resolveWorkosDomainVerification(candidate.domain, orgId, strategy);
          classified.push({ ...candidate, strategy, method });
        }
      } catch (err) {
        failures.push({ orgId, error: err instanceof Error ? err.message : String(err) });
      }
    }));
  }

  const counts = new Map<DomainVerificationMethod, number>();
  for (const row of classified) counts.set(row.method, (counts.get(row.method) ?? 0) + 1);
  console.log('\nResolved from WorkOS:');
  for (const method of ['dns', 'member_email', 'manual'] as const) {
    console.log(`  ${method}: ${counts.get(method) ?? 0}`);
  }
  console.log(`Not a verified WorkOS domain of the owning org (left alone): ${notVerifiedInWorkos.length}`);
  console.log(`WorkOS lookup failures (left alone): ${failures.length}`);

  const losing = classified.filter(row => row.method === 'manual');
  if (losing.length > 0) {
    console.log('\nWould lose domain_verified (administrator assertion only):');
    for (const row of losing) console.log(`  ${row.domain}  ${row.org_name ?? row.workos_organization_id}`);
  }
  if (notVerifiedInWorkos.length > 0) {
    console.log('\nLeft alone, review by hand:');
    for (const row of notVerifiedInWorkos) console.log(`  ${row.domain}  ${row.org_name ?? row.workos_organization_id}`);
  }
  for (const failure of failures) console.log(`  lookup failed for ${failure.orgId}: ${failure.error}`);

  if (!apply) {
    console.log('\nDRY-RUN -- pass --apply to write the resolved methods.');
    await closeDatabase();
    return;
  }

  let written = 0;
  for (const row of classified) {
    await brandDb.syncBrandDomainFromWorkos(row.domain, row.workos_organization_id, row.strategy, {
      reclassifyLegacy: true,
    });
    written++;
  }
  console.log(`\nWrote ${written} rows.`);
  await closeDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await closeDatabase();
  process.exit(1);
});
