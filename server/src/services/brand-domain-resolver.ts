/**
 * Single resolver for an org's brand-primary domain.
 *
 * After the Stage 2 column drop (#4159), the only source is
 * `organization_domains.is_primary=true`. Both org-membership-inference
 * and brand-identity now share this row. Returns null when an org has no
 * is_primary=true row.
 *
 * AUTHORIZATION: This is a low-level service with no authz inside. Callers
 * must have already verified the requesting principal has read access to
 * the supplied `orgId` (typically via `requireAuth` + membership check).
 */

import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-domain-resolver');

export interface BrandPrimaryDomainRecord {
  domain: string;
  verified: boolean;
}

/**
 * Resolve the brand-primary domain record for an org. Returns both `domain`
 * and `verified` so callers can gate on DNS proof-of-control. Returns null
 * when no is_primary=true row exists.
 */
export async function getBrandPrimaryDomainRecord(orgId: string): Promise<BrandPrimaryDomainRecord | null> {
  const pool = getPool();

  const od = await pool.query<{ domain: string; verified: boolean }>(
    `SELECT domain, verified FROM organization_domains
      WHERE workos_organization_id = $1 AND is_primary = true`,
    [orgId],
  );
  if (od.rows.length > 1) {
    logger.error(
      { orgId, count: od.rows.length, domains: od.rows.map((r) => r.domain) },
      'Multiple is_primary=true rows on organization_domains for one org — invariant broken',
    );
  }
  return od.rows[0] ? { domain: od.rows[0].domain, verified: od.rows[0].verified } : null;
}

/**
 * Convenience wrapper returning only the domain string. Delegates to
 * {@link getBrandPrimaryDomainRecord}. Use when verified status is not needed.
 */
export async function getBrandPrimaryDomain(orgId: string): Promise<string | null> {
  return (await getBrandPrimaryDomainRecord(orgId))?.domain ?? null;
}

/**
 * Batch variant. Returns a Map keyed by org_id with values of brand-primary
 * domain. Orgs with no is_primary=true row are absent from the map. Use
 * this from call sites that walk a list of orgs to avoid N+1 queries.
 */
export async function getBrandPrimaryDomainsForOrgs(
  orgIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (orgIds.length === 0) return result;

  const pool = getPool();

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
        'Multiple is_primary=true rows on organization_domains for one org — invariant broken',
      );
    }
  }

  return result;
}
