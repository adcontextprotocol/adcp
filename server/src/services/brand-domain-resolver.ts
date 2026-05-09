/**
 * Single resolver for an org's brand-primary domain.
 *
 * Stage 1 of the domain-column rationalization (#4159, spec at
 * specs/domain-column-rationalization.md). After Stage 0's backfill, the
 * canonical truth is `organization_domains.is_primary=true` for both
 * org-membership-inference and brand-identity. This function is the single
 * read surface for the brand-identity facet.
 *
 * During Stage 1, callers migrate from direct reads of
 * `member_profiles.primary_brand_domain` to this resolver. Writers continue
 * to dual-write both fields. Once every read site has migrated, Stage 2
 * drops the column and the fallback path here becomes a no-op (and gets
 * removed). Stage 3 introduces the matching `setPrimaryDomain` writer.
 *
 * The resolver returns `null` when an org has neither a primary on
 * organization_domains nor a profile-level brand_primary — caller must
 * decide whether that's a hard error or a soft "not yet set" path.
 *
 * AUTHORIZATION: This is a low-level service with no authz inside. Callers
 * must have already verified the requesting principal has read access to
 * the supplied `orgId` (typically via `requireAuth` + membership check).
 * Same trust posture as the existing `member_profiles.primary_brand_domain`
 * reads it replaces.
 */

import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-domain-resolver');

/**
 * Resolve the brand-primary domain for an org.
 *
 * Read order:
 *   1. `organization_domains.is_primary=true` (Stage 1 canonical)
 *   2. `member_profiles.primary_brand_domain` (transition fallback)
 *
 * The fallback exists for orgs Stage 0 missed (e.g., HYPD orphan, or new
 * orgs joining after the backfill ran). It logs a warn so we can spot any
 * remaining drift before Stage 2 drops the column.
 */
export async function getBrandPrimaryDomain(orgId: string): Promise<string | null> {
  const pool = getPool();

  // Read all is_primary=true rows (no LIMIT) so we can detect the rare case
  // of multiple primaries — Stage 0 enforced the "exactly 1" invariant on
  // every write path, but a future bug could regress it. logger.error so
  // it's loud; return the first row regardless (caller still gets a valid
  // primary, we don't want to bring the page down on a data anomaly).
  const od = await pool.query<{ domain: string }>(
    `SELECT domain FROM organization_domains
      WHERE workos_organization_id = $1 AND is_primary = true`,
    [orgId],
  );
  if (od.rows.length > 1) {
    logger.error(
      { orgId, count: od.rows.length, domains: od.rows.map((r) => r.domain) },
      'Multiple is_primary=true rows on organization_domains for one org — Stage 0 invariant broken',
    );
  }
  if (od.rows[0]) return od.rows[0].domain;

  // Fallback during transition. Post-Stage-0 should be near-empty; any hit
  // here is a drift signal worth surfacing for Stage-1.5 cleanup.
  const mp = await pool.query<{ primary_brand_domain: string | null }>(
    `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
    [orgId],
  );
  if (mp.rows[0]?.primary_brand_domain) {
    logger.warn(
      { orgId, fallback_value: mp.rows[0].primary_brand_domain },
      'getBrandPrimaryDomain fell back to member_profiles.primary_brand_domain — Stage 0 missed this org or it joined post-backfill',
    );
    return mp.rows[0].primary_brand_domain;
  }

  return null;
}

/**
 * Batch variant. Returns a Map keyed by org_id with values of brand-primary
 * domain. Orgs with neither a primary nor a fallback are absent from the
 * map (not present with a null/undefined value). Use this from call sites
 * that walk a list of orgs (e.g., dashboard list views, announcement-trigger
 * batches) to avoid N+1 queries.
 *
 * Same fallback semantics as `getBrandPrimaryDomain`: org_domains.is_primary
 * wins; profile field fills any gaps with a per-orgId warn.
 */
export async function getBrandPrimaryDomainsForOrgs(
  orgIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (orgIds.length === 0) return result;

  const pool = getPool();

  // Step 1: org_domains.is_primary=true rows for the requested orgs.
  // Detect multi-primary anomalies in the aggregate (one logger.error per
  // affected org rather than per row).
  const od = await pool.query<{ workos_organization_id: string; domain: string }>(
    `SELECT workos_organization_id, domain FROM organization_domains
      WHERE workos_organization_id = ANY($1::varchar[]) AND is_primary = true`,
    [orgIds],
  );
  const primaryCounts = new Map<string, string[]>();
  for (const row of od.rows) {
    const list = primaryCounts.get(row.workos_organization_id) ?? [];
    list.push(row.domain);
    primaryCounts.set(row.workos_organization_id, list);
    if (!result.has(row.workos_organization_id)) {
      result.set(row.workos_organization_id, row.domain);
    }
  }
  for (const [orgId, domains] of primaryCounts) {
    if (domains.length > 1) {
      logger.error(
        { orgId, count: domains.length, domains },
        'Multiple is_primary=true rows on organization_domains for one org — Stage 0 invariant broken',
      );
    }
  }

  // Step 2: fall back to member_profiles for orgs not yet in the result.
  // Aggregate the fallback warn into a single log line per batch instead of
  // one-per-row — keeps the signal usable even if a large batch hits many
  // fallbacks.
  const missing = orgIds.filter((id) => !result.has(id));
  if (missing.length > 0) {
    const mp = await pool.query<{ workos_organization_id: string; primary_brand_domain: string }>(
      `SELECT workos_organization_id, primary_brand_domain
         FROM member_profiles
        WHERE workos_organization_id = ANY($1::varchar[])
          AND primary_brand_domain IS NOT NULL`,
      [missing],
    );
    if (mp.rows.length > 0) {
      logger.warn(
        {
          count: mp.rows.length,
          orgIds: mp.rows.map((r) => r.workos_organization_id),
        },
        'getBrandPrimaryDomainsForOrgs fell back to member_profiles.primary_brand_domain for some orgs',
      );
    }
    for (const row of mp.rows) {
      result.set(row.workos_organization_id, row.primary_brand_domain);
    }
  }

  return result;
}
