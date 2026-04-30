import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('org-filters');

/**
 * Shared SQL filters for organization tiers
 *
 * Three mutually exclusive tiers (highest wins):
 * - Members: active subscription (including comped members with $0 amount)
 * - Engaged: not paying, but has at least one site user with community points
 *            OR at least one Slack user with activity in the last 30 days
 * - Registered: not paying, no engaged users, but has at least one user on site/Slack
 *
 * Organizations with no users at all (pure prospect placeholders) are excluded from analytics.
 *
 * IMPORTANT: These filters assume the table alias is 'organizations' or no alias.
 * If using a different alias (e.g., 'o'), use the aliased versions.
 */

// =============================================================================
// Core filters (for use with 'organizations' table name or no alias)
// =============================================================================

/** Organization has an active, non-canceled subscription */
export const MEMBER_FILTER = `subscription_status = 'active' AND subscription_canceled_at IS NULL`;

/** Organization has at least one user (site account or Slack user) */
export const HAS_USER = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.workos_organization_id = organizations.workos_organization_id
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    JOIN organization_domains od ON LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(od.domain)
    WHERE od.workos_organization_id = organizations.workos_organization_id
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
  )
)`;

/** Organization has at least one user with community points OR Slack user with recent activity */
export const HAS_ENGAGED_USER = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN community_points cp ON cp.workos_user_id = om.workos_user_id
    WHERE om.workos_organization_id = organizations.workos_organization_id
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    JOIN organization_domains od ON LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(od.domain)
    WHERE od.workos_organization_id = organizations.workos_organization_id
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
      AND sm.last_slack_activity_at >= CURRENT_DATE - INTERVAL '30 days'
  )
)`;

/** Engaged tier: not a member, but has engaged users */
export const ENGAGED_FILTER = `NOT (${MEMBER_FILTER}) AND ${HAS_ENGAGED_USER}`;

/** Registered tier: not a member, no engaged users, but has at least one user */
export const REGISTERED_FILTER = `NOT (${MEMBER_FILTER}) AND NOT ${HAS_ENGAGED_USER} AND ${HAS_USER}`;

/** Not a member (for prospect/non-member queries) */
export const NOT_MEMBER = `NOT (${MEMBER_FILTER})`;

// =============================================================================
// Aliased filters (for use with 'o' alias, common in admin routes)
// =============================================================================

/** Organization has an active, non-canceled subscription (aliased) */
export const MEMBER_FILTER_ALIASED = `o.subscription_status = 'active' AND o.subscription_canceled_at IS NULL`;

/** Organization has at least one user (site account or Slack user) (aliased) */
export const HAS_USER_ALIASED = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.workos_organization_id = o.workos_organization_id
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    JOIN organization_domains od ON LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(od.domain)
    WHERE od.workos_organization_id = o.workos_organization_id
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
  )
)`;

/** Organization has at least one user with community points OR Slack user with recent activity (aliased) */
export const HAS_ENGAGED_USER_ALIASED = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN community_points cp ON cp.workos_user_id = om.workos_user_id
    WHERE om.workos_organization_id = o.workos_organization_id
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    JOIN organization_domains od ON LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(od.domain)
    WHERE od.workos_organization_id = o.workos_organization_id
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
      AND sm.last_slack_activity_at >= CURRENT_DATE - INTERVAL '30 days'
  )
)`;

/** Engaged tier: not a member, but has engaged users (aliased) */
export const ENGAGED_FILTER_ALIASED = `NOT (${MEMBER_FILTER_ALIASED}) AND ${HAS_ENGAGED_USER_ALIASED}`;

/** Registered tier: not a member, no engaged users, but has at least one user (aliased) */
export const REGISTERED_FILTER_ALIASED = `NOT (${MEMBER_FILTER_ALIASED}) AND NOT ${HAS_ENGAGED_USER_ALIASED} AND ${HAS_USER_ALIASED}`;

/** Not a member (for prospect/non-member queries) (aliased) */
export const NOT_MEMBER_ALIASED = `NOT (${MEMBER_FILTER_ALIASED})`;

// =============================================================================
// Helper types
// =============================================================================

export type OrgTier = 'member' | 'engaged' | 'registered' | 'prospect';

/** TypeScript predicate matching the SQL MEMBER_FILTER — use wherever is_member/is_paying_member is derived in application code. */
export function isPayingMembership(row: {
  subscription_status: string | null;
  subscription_canceled_at: Date | null;
}): boolean {
  return row.subscription_status === 'active' && row.subscription_canceled_at === null;
}

/**
 * Determine the tier for an organization based on its data
 * This is for TypeScript logic, not SQL queries
 */
export function getOrgTier(org: {
  subscription_status: string | null;
  subscription_canceled_at: Date | null;
  has_users: boolean;
  has_engaged_users: boolean;
}): OrgTier {
  // Member: active, non-canceled subscription
  if (
    org.subscription_status === 'active' &&
    !org.subscription_canceled_at
  ) {
    return 'member';
  }

  // Engaged: has users with engagement
  if (org.has_engaged_users) {
    return 'engaged';
  }

  // Registered: has users but no engagement
  if (org.has_users) {
    return 'registered';
  }

  // Prospect: no users at all
  return 'prospect';
}

// =============================================================================
// Membership inheritance via brand registry hierarchy
// =============================================================================

export interface EffectiveMembership {
  is_member: boolean;
  is_inherited: boolean;
  paying_org_id: string | null;
  paying_org_name: string | null;
  hierarchy_chain: string[];
  membership_tier: string | null;
}

// Cache: org_id → { result, expires_at }
const membershipCache = new Map<string, { result: EffectiveMembership; expires_at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve effective membership for an organization, including inheritance
 * through the brand registry hierarchy (house_domain chain).
 *
 * If the org itself is a paying member, returns direct membership.
 * Otherwise, walks up the house_domain chain looking for a paying ancestor.
 *
 * Trust gates on inheritance — same shape as findPayingOrgForDomain so the
 * pre-link auto-provisioning path and post-link is_member resolution agree
 * on which edges are trustworthy:
 *   - max 4 hops up
 *   - cycle protection via visited-domain array
 *   - only edges classified at confidence='high' (LLM classifier output)
 *   - 180-day TTL on the brand classification
 *   - inherited match only counts if the paying ancestor has opted into
 *     auto_provision_brand_hierarchy_children (default false). Without
 *     opt-in, the child org's is_member stays false even if the brand
 *     registry says it's a subsidiary.
 *
 * The opt-in gate at the post-link step matches the auto-provision step:
 * an admin who hasn't consented to auto-joining children doesn't grant
 * "you're a member" feature access to those children either.
 */
export async function resolveEffectiveMembership(orgId: string): Promise<EffectiveMembership> {
  // Check cache
  const cached = membershipCache.get(orgId);
  if (cached && cached.expires_at > Date.now()) {
    return cached.result;
  }

  const pool = getPool();

  try {
    const result = await pool.query<{
      workos_organization_id: string;
      email_domain: string | null;
      name: string;
      subscription_status: string | null;
      subscription_canceled_at: Date | null;
      membership_tier: string | null;
      auto_provision_hierarchy: boolean;
      depth: number;
    }>(`
      WITH RECURSIVE org_chain AS (
        -- Start: the org in question
        SELECT o.workos_organization_id, o.email_domain, o.name,
               o.subscription_status, o.subscription_canceled_at,
               o.membership_tier,
               COALESCE(o.auto_provision_brand_hierarchy_children, false) AS auto_provision_hierarchy,
               1 as depth,
               ARRAY[o.email_domain]::TEXT[] as visited
        FROM organizations o
        WHERE o.workos_organization_id = $1

        UNION ALL

        -- Walk up: join through brands.house_domain. Same trust gates as
        -- findPayingOrgForDomain — high-confidence only, 180-day freshness.
        SELECT parent_o.workos_organization_id, parent_o.email_domain, parent_o.name,
               parent_o.subscription_status, parent_o.subscription_canceled_at,
               parent_o.membership_tier,
               COALESCE(parent_o.auto_provision_brand_hierarchy_children, false) AS auto_provision_hierarchy,
               oc.depth + 1,
               oc.visited || parent_o.email_domain
        FROM org_chain oc
        JOIN brands db ON db.domain = oc.email_domain
        JOIN organizations parent_o ON parent_o.email_domain = db.house_domain
        WHERE db.house_domain IS NOT NULL
          AND oc.depth < 5
          AND db.brand_manifest->'classification'->>'confidence' = 'high'
          AND COALESCE(db.last_validated, db.discovered_at, db.created_at)
              > NOW() - INTERVAL '180 days'
          AND parent_o.email_domain != ALL(oc.visited)
      )
      SELECT workos_organization_id, email_domain, name,
             subscription_status, subscription_canceled_at,
             membership_tier, auto_provision_hierarchy, depth
      FROM org_chain
      ORDER BY depth ASC
    `, [orgId]);

    const rows = result.rows;

    if (rows.length === 0) {
      const noResult: EffectiveMembership = {
        is_member: false,
        is_inherited: false,
        paying_org_id: null,
        paying_org_name: null,
        hierarchy_chain: [],
        membership_tier: null,
      };
      membershipCache.set(orgId, { result: noResult, expires_at: Date.now() + CACHE_TTL_MS });
      return noResult;
    }

    // Check the org itself first (depth 1) — opt-in flag does not apply to
    // self; an org's own paying subscription always counts.
    const self = rows[0];
    if (self.subscription_status === 'active' && !self.subscription_canceled_at) {
      const directResult: EffectiveMembership = {
        is_member: true,
        is_inherited: false,
        paying_org_id: self.workos_organization_id,
        paying_org_name: self.name,
        hierarchy_chain: [self.email_domain].filter(Boolean) as string[],
        membership_tier: self.membership_tier,
      };
      membershipCache.set(orgId, { result: directResult, expires_at: Date.now() + CACHE_TTL_MS });
      return directResult;
    }

    // Check ancestors (depth > 1) for a paying member that has opted into
    // hierarchy inheritance. An ancestor that didn't consent to children
    // auto-joining doesn't grant is_member to those children either.
    for (const row of rows.slice(1)) {
      if (row.subscription_status === 'active' && !row.subscription_canceled_at && row.auto_provision_hierarchy) {
        const chain = rows
          .filter(r => r.depth <= row.depth)
          .map(r => r.email_domain)
          .filter(Boolean) as string[];

        const inheritedResult: EffectiveMembership = {
          is_member: true,
          is_inherited: true,
          paying_org_id: row.workos_organization_id,
          paying_org_name: row.name,
          hierarchy_chain: chain,
          membership_tier: row.membership_tier,
        };
        membershipCache.set(orgId, { result: inheritedResult, expires_at: Date.now() + CACHE_TTL_MS });
        return inheritedResult;
      }
    }

    // No paying member in chain
    const noMemberResult: EffectiveMembership = {
      is_member: false,
      is_inherited: false,
      paying_org_id: null,
      paying_org_name: null,
      hierarchy_chain: rows.map(r => r.email_domain).filter(Boolean) as string[],
      membership_tier: null,
    };
    membershipCache.set(orgId, { result: noMemberResult, expires_at: Date.now() + CACHE_TTL_MS });
    return noMemberResult;
  } catch (error) {
    logger.error({ err: error, orgId }, 'Failed to resolve effective membership');
    return {
      is_member: false,
      is_inherited: false,
      paying_org_id: null,
      paying_org_name: null,
      hierarchy_chain: [],
      membership_tier: null,
    };
  }
}

/** Clear the membership cache for a specific org (e.g., after subscription change) */
export function invalidateMembershipCache(orgId?: string): void {
  if (orgId) {
    membershipCache.delete(orgId);
  } else {
    membershipCache.clear();
  }
}

// =============================================================================
// Find paying org for a raw domain (auto-link target resolution)
// =============================================================================

export interface DomainOwnerOrg {
  organization_id: string;
  organization_name: string;
  /** True when matched_domain != input domain (came via brand-hierarchy ascent). */
  is_inherited: boolean;
  /** The verified-domain row that actually matched a paying org. */
  matched_domain: string;
  /** Domains walked from input → matched_domain, inclusive. */
  hierarchy_chain: string[];
  /** Direct (non-inherited) auto-provisioning is allowed on the resolved org. */
  auto_provision_direct_allowed: boolean;
  /** Hierarchical (inherited) auto-provisioning is allowed on the resolved org. Default false. */
  auto_provision_hierarchy_allowed: boolean;
  /**
   * Timestamp the paying org enabled auto_provision_brand_hierarchy_children.
   * Cohort gate: callers should only auto-link inherited matches for users
   * created on or after this time. NULL when the flag is off (no cohort).
   */
  auto_provision_hierarchy_enabled_at: Date | null;
}

/**
 * Find the paying organization that "owns" a raw email domain — directly via a
 * verified `organization_domains` row or transitively up the brand registry's
 * `house_domain` chain.
 *
 * Returns the closest match: a direct verified-domain hit on the input wins
 * over an inherited one. When two ancestors at different depths both have
 * paying orgs, the shallower one wins.
 *
 * Trust gates on the inheritance walk:
 *   - max 4 hops up from the input domain
 *   - cycle protection via visited-domain array
 *   - only edges classified at confidence='high' by the brand classifier
 *     (brand-classifier.ts). source_type='brand_json' is NOT a trust signal —
 *     brand.json schema has no parent/house_domain field today, so brand_json
 *     rows never carry inheritance data, and the crawler does not authenticate
 *     domain ownership for brand_json discoveries.
 *   - 180-day TTL on the brand classification (last_validated, fallback to
 *     discovered_at) so divestments age out instead of inheriting forever.
 *
 * Caller is responsible for honoring `auto_provision_*_allowed` flags and any
 * already-a-member short-circuit. The two flags split direct vs. inherited
 * auto-provisioning consent — orgs default to direct=true (DNS-verified, low
 * risk) and inherited=false (LLM-classified, opt-in).
 */
export async function findPayingOrgForDomain(domain: string): Promise<DomainOwnerOrg | null> {
  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedDomain) return null;

  const pool = getPool();

  try {
    const result = await pool.query<{
      depth: number;
      domain: string;
      workos_organization_id: string;
      org_name: string;
      auto_provision_direct: boolean;
      auto_provision_hierarchy: boolean;
      auto_provision_hierarchy_enabled_at: Date | null;
    }>(`
      WITH RECURSIVE domain_chain AS (
        -- Start: the user's email domain
        SELECT $1::text AS domain, 1 AS depth, ARRAY[$1::text]::TEXT[] AS visited

        UNION ALL

        -- Walk up: brands.house_domain points to the parent brand's domain.
        -- Trust gates: high-confidence classification, last validated within
        -- 180 days, no cycles, max 4 hops up.
        SELECT db.house_domain AS domain, dc.depth + 1, dc.visited || db.house_domain
        FROM domain_chain dc
        JOIN brands db ON db.domain = dc.domain
        WHERE db.house_domain IS NOT NULL
          AND dc.depth < 5
          AND db.house_domain != ALL(dc.visited)
          AND db.brand_manifest->'classification'->>'confidence' = 'high'
          AND COALESCE(db.last_validated, db.discovered_at, db.created_at)
              > NOW() - INTERVAL '180 days'
      ),
      paying_match AS (
        SELECT
          dc.depth,
          dc.domain,
          od.workos_organization_id,
          o.name AS org_name,
          COALESCE(o.auto_provision_verified_domain, true) AS auto_provision_direct,
          COALESCE(o.auto_provision_brand_hierarchy_children, false) AS auto_provision_hierarchy,
          o.auto_provision_hierarchy_enabled_at
        FROM domain_chain dc
        JOIN organization_domains od ON LOWER(od.domain) = LOWER(dc.domain)
        JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
        WHERE od.verified = true
          AND o.subscription_status = 'active'
          AND o.subscription_canceled_at IS NULL
        ORDER BY dc.depth ASC  -- direct match (depth 1) wins over inherited
        LIMIT 1
      )
      SELECT * FROM paying_match
    `, [normalizedDomain]);

    if (result.rows.length === 0) return null;

    const match = result.rows[0];

    // Reconstruct the chain from input domain to matched_domain. For a direct
    // match this is just [input]; for an inherited match it's [input, ..., matched_domain].
    // Bound is `< $2` (matching the first CTE's `< 5`) so we don't recurse one
    // step past the matched depth and pull in non-paying ancestors.
    const chainResult = await pool.query<{ domain: string; depth: number }>(`
      WITH RECURSIVE domain_chain AS (
        SELECT $1::text AS domain, 1 AS depth, ARRAY[$1::text]::TEXT[] AS visited

        UNION ALL

        SELECT db.house_domain AS domain, dc.depth + 1, dc.visited || db.house_domain
        FROM domain_chain dc
        JOIN brands db ON db.domain = dc.domain
        WHERE db.house_domain IS NOT NULL
          AND dc.depth < $2
          AND db.house_domain != ALL(dc.visited)
          AND db.brand_manifest->'classification'->>'confidence' = 'high'
          AND COALESCE(db.last_validated, db.discovered_at, db.created_at)
              > NOW() - INTERVAL '180 days'
      )
      SELECT domain, depth FROM domain_chain ORDER BY depth ASC
    `, [normalizedDomain, match.depth]);

    return {
      organization_id: match.workos_organization_id,
      organization_name: match.org_name,
      is_inherited: match.depth > 1,
      matched_domain: match.domain,
      hierarchy_chain: chainResult.rows.map((r) => r.domain),
      auto_provision_direct_allowed: match.auto_provision_direct,
      auto_provision_hierarchy_allowed: match.auto_provision_hierarchy,
      auto_provision_hierarchy_enabled_at: match.auto_provision_hierarchy_enabled_at,
    };
  } catch (error) {
    logger.error({ err: error, domain: normalizedDomain }, 'Failed to find paying org for domain');
    return null;
  }
}
