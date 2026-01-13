/**
 * Shared SQL filters for organization tiers
 *
 * Three mutually exclusive tiers (highest wins):
 * - Members: paying subscription
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

/** Organization has at least one user (site account or Slack user by domain) */
export const HAS_USER = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.workos_organization_id = organizations.workos_organization_id
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    WHERE organizations.email_domain IS NOT NULL
      AND LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(organizations.email_domain)
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
  )
)`;

/** Organization has at least one user with engagement_score > 0 OR Slack user with activity */
export const HAS_ENGAGED_USER = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN users u ON u.workos_user_id = om.workos_user_id
    WHERE om.workos_organization_id = organizations.workos_organization_id
    AND u.engagement_score > 0
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    JOIN slack_activity_daily sad ON sad.slack_user_id = sm.slack_user_id
    WHERE organizations.email_domain IS NOT NULL
      AND LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(organizations.email_domain)
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
      AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'
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

/** Organization has at least one user (site account or Slack user by domain) (aliased) */
export const HAS_USER_ALIASED = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.workos_organization_id = o.workos_organization_id
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    WHERE o.email_domain IS NOT NULL
      AND LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(o.email_domain)
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
  )
)`;

/** Organization has at least one user with engagement_score > 0 OR Slack user with activity (aliased) */
export const HAS_ENGAGED_USER_ALIASED = `(
  EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN users u ON u.workos_user_id = om.workos_user_id
    WHERE om.workos_organization_id = o.workos_organization_id
    AND u.engagement_score > 0
  )
  OR EXISTS (
    SELECT 1 FROM slack_user_mappings sm
    JOIN slack_activity_daily sad ON sad.slack_user_id = sm.slack_user_id
    WHERE o.email_domain IS NOT NULL
      AND LOWER(SPLIT_PART(sm.slack_email, '@', 2)) = LOWER(o.email_domain)
      AND sm.slack_is_bot = false
      AND sm.slack_is_deleted = false
      AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'
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
