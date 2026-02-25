import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('org-filters');

/**
 * Shared SQL filters for organization tiers
 *
 * Three mutually exclusive tiers (highest wins):
 * - Members: active subscription (including comped members with $0 amount)
 * - Engaged: not paying, but has at least one site user with engagement_score > 0
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

/** Organization has at least one user with engagement_score > 0 OR Slack user with recent activity */
export const HAS_ENGAGED_USER = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN users u ON u.workos_user_id = om.workos_user_id
    WHERE om.workos_organization_id = organizations.workos_organization_id
    AND u.engagement_score > 0
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

/** Organization has at least one user with engagement_score > 0 OR Slack user with recent activity (aliased) */
export const HAS_ENGAGED_USER_ALIASED = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN users u ON u.workos_user_id = om.workos_user_id
    WHERE om.workos_organization_id = o.workos_organization_id
    AND u.engagement_score > 0
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
 * Otherwise, walks up the house_domain chain (max 5 hops) looking for
 * a paying ancestor org. Only traverses high-confidence classifications.
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
      depth: number;
    }>(`
      WITH RECURSIVE org_chain AS (
        -- Start: the org in question
        SELECT o.workos_organization_id, o.email_domain, o.name,
               o.subscription_status, o.subscription_canceled_at,
               o.membership_tier, 1 as depth,
               ARRAY[o.email_domain] as visited
        FROM organizations o
        WHERE o.workos_organization_id = $1

        UNION ALL

        -- Walk up: join through discovered_brands.house_domain
        SELECT parent_o.workos_organization_id, parent_o.email_domain, parent_o.name,
               parent_o.subscription_status, parent_o.subscription_canceled_at,
               parent_o.membership_tier, oc.depth + 1,
               oc.visited || parent_o.email_domain
        FROM org_chain oc
        JOIN discovered_brands db ON db.domain = oc.email_domain
        JOIN organizations parent_o ON parent_o.email_domain = db.house_domain
        WHERE db.house_domain IS NOT NULL
          AND oc.depth < 5
          AND (db.brand_manifest->'classification'->>'confidence' = 'high'
               OR db.source_type = 'brand_json')
          AND parent_o.email_domain != ALL(oc.visited)
      )
      SELECT workos_organization_id, email_domain, name,
             subscription_status, subscription_canceled_at,
             membership_tier, depth
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

    // Check the org itself first (depth 1)
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

    // Check ancestors (depth > 1) for paying member
    for (const row of rows.slice(1)) {
      if (row.subscription_status === 'active' && !row.subscription_canceled_at) {
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
