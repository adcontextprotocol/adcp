/**
 * Domain resolution: given a domain, find the organization it belongs to.
 *
 * Checks multiple sources in priority order:
 *   1. organization_domains / organizations.email_domain  (exact)
 *   2. brand_domain_aliases → discovered_brands → org     (brand registry alias)
 *   3. discovered_brands.house_domain → org               (sub-brand → parent)
 *   4. HTTP redirect check → re-resolve with target       (arcspan.ai → arcspan.com)
 *
 * Every caller that needs to answer "does this domain already belong to someone?"
 * should use this module instead of writing ad-hoc queries.
 */

import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('domain-resolution');

export interface DomainResolution {
  orgId: string;
  matchedDomain: string;
  method: 'exact' | 'brand_alias' | 'sub_brand' | 'redirect';
}

/**
 * Resolve a domain to an organization through all known alias paths.
 * Returns null if no match is found.
 */
export async function resolveOrgByDomain(domain: string): Promise<DomainResolution | null> {
  const normalized = domain.toLowerCase().trim();

  // Try database lookups first (fast)
  const dbResult = await resolveFromDatabase(normalized);
  if (dbResult) return dbResult;

  // No DB match — check if the domain redirects to a different one
  const redirectTarget = await resolveRedirectDomain(normalized);
  if (redirectTarget && redirectTarget !== normalized) {
    const redirectResult = await resolveFromDatabase(redirectTarget);
    if (redirectResult) {
      // Persist the alias so future lookups skip the HTTP check
      persistRedirectAlias(normalized, redirectTarget);
      return { ...redirectResult, method: 'redirect' };
    }
  }

  return null;
}

/**
 * Batch resolve multiple domains to organizations using database-only lookups.
 * No HTTP redirect checks — too slow for batch use.
 *
 * Uses a single query that unions all three DB resolution paths. When a domain
 * matches multiple paths, exact > brand_alias > sub_brand wins.
 */
export async function resolveOrgsByDomains(domains: string[]): Promise<Map<string, DomainResolution>> {
  const result = new Map<string, DomainResolution>();
  if (domains.length === 0) return result;

  const normalized = domains.map(d => d.toLowerCase().trim());
  const pool = getPool();

  const rows = await pool.query<{
    input_domain: string;
    workos_organization_id: string;
    matched_domain: string;
    method: 'exact' | 'brand_alias' | 'sub_brand';
    priority: number;
  }>(
    `WITH inputs AS (SELECT UNNEST($1::text[]) AS domain),
     exact AS (
       SELECT i.domain AS input_domain,
              o.workos_organization_id,
              COALESCE(od.domain, o.email_domain) AS matched_domain,
              'exact' AS method,
              1 AS priority
       FROM inputs i
       JOIN organizations o
         ON o.email_domain = i.domain
       LEFT JOIN organization_domains od
         ON od.workos_organization_id = o.workos_organization_id AND od.domain = i.domain
       UNION ALL
       SELECT i.domain AS input_domain,
              o.workos_organization_id,
              od.domain AS matched_domain,
              'exact' AS method,
              1 AS priority
       FROM inputs i
       JOIN organization_domains od ON od.domain = i.domain
       JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
       WHERE NOT EXISTS (
         SELECT 1 FROM organizations o2 WHERE o2.email_domain = i.domain
       )
     ),
     brand AS (
       SELECT i.domain AS input_domain,
              o.workos_organization_id,
              bda.brand_domain AS matched_domain,
              'brand_alias' AS method,
              2 AS priority
       FROM inputs i
       JOIN brand_domain_aliases bda ON bda.alias_domain = i.domain
       JOIN organizations o ON o.email_domain = bda.brand_domain
     ),
     sub AS (
       SELECT i.domain AS input_domain,
              o.workos_organization_id,
              db.house_domain AS matched_domain,
              'sub_brand' AS method,
              3 AS priority
       FROM inputs i
       JOIN discovered_brands db ON db.domain = i.domain
         AND db.house_domain IS NOT NULL
         AND db.house_domain != i.domain
       JOIN organizations o ON o.email_domain = db.house_domain
     ),
     all_matches AS (
       SELECT * FROM exact
       UNION ALL SELECT * FROM brand
       UNION ALL SELECT * FROM sub
     )
     SELECT DISTINCT ON (input_domain)
       input_domain, workos_organization_id, matched_domain, method, priority
     FROM all_matches
     ORDER BY input_domain, priority, workos_organization_id`,
    [normalized]
  );

  for (const row of rows.rows) {
    result.set(row.input_domain, {
      orgId: row.workos_organization_id,
      matchedDomain: row.matched_domain,
      method: row.method,
    });
  }

  return result;
}

/**
 * Database-only resolution: exact match, brand alias, sub-brand hierarchy.
 */
async function resolveFromDatabase(normalized: string): Promise<DomainResolution | null> {
  const pool = getPool();

  // 1. Exact match: organization_domains or organizations.email_domain
  const exact = await pool.query<{ workos_organization_id: string; domain: string }>(
    `SELECT o.workos_organization_id, COALESCE(od.domain, o.email_domain) AS domain
     FROM organizations o
     LEFT JOIN organization_domains od
       ON o.workos_organization_id = od.workos_organization_id AND od.domain = $1
     WHERE o.email_domain = $1 OR od.domain = $1
     LIMIT 1`,
    [normalized]
  );

  if (exact.rows.length > 0) {
    return {
      orgId: exact.rows[0].workos_organization_id,
      matchedDomain: exact.rows[0].domain,
      method: 'exact',
    };
  }

  // 2. Brand alias: domain is a known alias → resolve to canonical brand → find org
  //    e.g. omc.com → omnicomgroup.com → Omnicom org
  const brandAlias = await pool.query<{ workos_organization_id: string; brand_domain: string }>(
    `SELECT o.workos_organization_id, bda.brand_domain
     FROM brand_domain_aliases bda
     JOIN organizations o ON o.email_domain = bda.brand_domain
     WHERE bda.alias_domain = $1
     LIMIT 1`,
    [normalized]
  );

  if (brandAlias.rows.length > 0) {
    return {
      orgId: brandAlias.rows[0].workos_organization_id,
      matchedDomain: brandAlias.rows[0].brand_domain,
      method: 'brand_alias',
    };
  }

  // 3. Sub-brand: domain is a discovered brand whose house_domain maps to an org
  //    e.g. instagram.com → house_domain=meta.com → Meta org
  const subBrand = await pool.query<{ workos_organization_id: string; house_domain: string }>(
    `SELECT o.workos_organization_id, db.house_domain
     FROM discovered_brands db
     JOIN organizations o ON o.email_domain = db.house_domain
     WHERE db.domain = $1
       AND db.house_domain IS NOT NULL
       AND db.house_domain != $1
     LIMIT 1`,
    [normalized]
  );

  if (subBrand.rows.length > 0) {
    return {
      orgId: subBrand.rows[0].workos_organization_id,
      matchedDomain: subBrand.rows[0].house_domain,
      method: 'sub_brand',
    };
  }

  return null;
}

/**
 * Persist a redirect-discovered alias into brand_domain_aliases so future
 * lookups resolve via the database instead of making an HTTP request.
 * Fire-and-forget — callers should not await this.
 */
function persistRedirectAlias(aliasDomain: string, targetDomain: string): void {
  const pool = getPool();
  pool.query(
    `INSERT INTO brand_domain_aliases (alias_domain, brand_domain, source)
     VALUES ($1, $2, 'redirect')
     ON CONFLICT (alias_domain) DO NOTHING`,
    [aliasDomain, targetDomain]
  ).then((result) => {
    if (result.rowCount && result.rowCount > 0) {
      logger.info({ aliasDomain, targetDomain }, 'Persisted redirect alias');
    }
  }).catch((err) => {
    logger.warn({ err, aliasDomain, targetDomain }, 'Failed to persist redirect alias');
  });
}

// Private/reserved IP patterns — block SSRF via redirect to internal services
const PRIVATE_IP_RE = /^(localhost|0\.0\.0\.0|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|fc|fd|fe80|::1|\[::)/i;

/**
 * Follow HTTP redirects to find the canonical domain.
 * Tries HEAD first (lightweight), falls back to GET if the server rejects HEAD.
 * Returns the resolved domain, or null on failure.
 *
 * SSRF protection: only follows HTTPS, rejects private IPs and non-hostname targets.
 */
async function resolveRedirectDomain(domain: string): Promise<string | null> {
  // Block requests to private/reserved ranges
  if (PRIVATE_IP_RE.test(domain)) return null;

  // Only resolve domains that look like valid hostnames (no IPs, no ports)
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) return null;

  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://${domain}`, {
        method,
        redirect: 'manual',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // HEAD rejected — try GET
      if (method === 'HEAD' && response.status === 405) continue;

      // Only inspect 3xx redirects — read the Location header without following
      const status = response.status;
      if (status < 300 || status >= 400) return null;

      const location = response.headers.get('location');
      if (!location) return null;

      let parsed: URL;
      try {
        parsed = new URL(location, `https://${domain}`);
      } catch {
        return null;
      }

      // Only accept HTTPS redirects to valid hostnames
      if (parsed.protocol !== 'https:') return null;
      if (PRIVATE_IP_RE.test(parsed.hostname)) return null;
      // Validate hostname format (no IPs, no ports in hostname)
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(parsed.hostname)) return null;

      const finalDomain = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (finalDomain !== domain) {
        logger.debug({ from: domain, to: finalDomain }, 'Domain redirect detected');
        return finalDomain;
      }

      return null;
    } catch {
      if (method === 'HEAD') continue; // try GET
      return null; // both failed
    }
  }

  return null;
}
