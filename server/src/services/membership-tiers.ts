/**
 * Membership tier constants — single source of truth for which tiers grant
 * API-access privileges (badge issuance, agent registration with auth, etc.).
 *
 * Used by:
 *  - `compliance-heartbeat.ts` to gate badge issuance on API-access membership
 *  - The `/registry/agents/:url/compliance` route to surface tier eligibility
 *    on the verification panel
 *
 * Keep in sync with the `organizations.membership_tier` enum and the public
 * AAO membership-pricing taxonomy (project_membership_pricing_v2).
 */

import { resolvePrimaryOrganization } from '../db/users-db.js';
import { resolveEffectiveMembership } from '../db/org-filters.js';
import { getPool } from '../db/client.js';
import {
  MEMBERSHIP_TIER_COLUMNS,
  resolveMembershipTier,
  type MembershipTierRow,
} from '../db/organization-db.js';

export const API_ACCESS_TIERS = [
  'individual_professional',
  'company_standard',
  'company_icl',
  'company_leader',
] as const;

export type ApiAccessTier = (typeof API_ACCESS_TIERS)[number];

const API_ACCESS_TIER_SET: ReadonlySet<string> = new Set(API_ACCESS_TIERS);

export function isApiAccessTier(tier: string | null | undefined): boolean {
  return tier != null && API_ACCESS_TIER_SET.has(tier);
}

/**
 * Subscription statuses that count as "active enough" to retain badge
 * eligibility. `past_due` is intentionally included — Stripe gives a grace
 * window for payment recovery, and revoking the badge mid-grace would be
 * a poor experience for sellers whose payment method is between charges.
 * `trialing` covers the brief window between sign-up and first charge.
 */
export const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'trialing'] as const;

export type ActiveSubscriptionStatus = (typeof ACTIVE_SUBSCRIPTION_STATUSES)[number];

const ACTIVE_SUBSCRIPTION_STATUS_SET: ReadonlySet<string> = new Set(ACTIVE_SUBSCRIPTION_STATUSES);

export function isActiveSubscriptionStatus(status: string | null | undefined): boolean {
  return status != null && ACTIVE_SUBSCRIPTION_STATUS_SET.has(status);
}

interface ContentSubmissionMembership {
  membership_tier: string | null;
  subscription_status: string | null;
  subscription_canceled_at: Date | null;
}

export function isContentSubmissionMembershipEligible(
  membership: ContentSubmissionMembership | null,
): boolean {
  return membership != null
    && membership.subscription_canceled_at === null
    && isActiveSubscriptionStatus(membership.subscription_status)
    && isApiAccessTier(membership.membership_tier);
}

/**
 * Buyer-facing labels for membership tiers. Used when the verification panel
 * surfaces "Your tier: X" so the dashboard doesn't show the raw enum.
 *
 * Keep aligned with the public membership pricing page; falling back to the
 * raw enum for unrecognized values is intentional — better to show something
 * than to mask a future tier the dashboard hasn't learned yet.
 */
const TIER_LABELS: Record<string, string> = {
  explorer: 'Explorer',
  individual_professional: 'Professional',
  company_standard: 'Builder',
  company_icl: 'Partner',
  company_leader: 'Leader',
};

export function tierLabel(tier: string | null | undefined): string | null {
  if (!tier) return null;
  return TIER_LABELS[tier] ?? tier;
}

export interface OwnerMembership {
  /**
   * True only when the caller actually owns the agent (the resolver found
   * a matching member_profiles row + organization_memberships row for them).
   * Use this for owner-only feature gates that don't need a specific tier —
   * `is_api_access_tier` is narrower (only premium tiers + active subs).
   * Not surfaced in API responses; internal struct only. Response shape
   * stays owner-detect-resistant via constant keys + null values.
   */
  is_owner: boolean;
  membership_tier: string | null;
  membership_tier_label: string | null;
  subscription_status: string | null;
  is_api_access_tier: boolean;
}

const EMPTY_OWNER_MEMBERSHIP: OwnerMembership = {
  is_owner: false,
  membership_tier: null,
  membership_tier_label: null,
  subscription_status: null,
  is_api_access_tier: false,
};

export interface ResolveOwnerMembershipDeps {
  resolveOwnerOrgId: (userId: string, agentUrl: string) => Promise<string | null>;
  fetchOrgMembership: (orgId: string) => Promise<{ membership_tier: string | null; subscription_status: string | null } | null>;
}

/**
 * The security boundary for the verification panel's tier inline display:
 * given a user id (or none, for anonymous) and an agent url, resolve the
 * owner-scoped membership shape — populated only when the caller actually
 * owns the agent.
 *
 * Pure dispatcher; the two DB lookups are injected so this can be unit-tested
 * without spinning up Postgres. Returns the EMPTY_OWNER_MEMBERSHIP shape
 * (constant keys, null/false values) on every miss path so the eventual
 * JSON response has the same `Object.keys()` for owners and non-owners — a
 * non-owner cannot detect ownership by comparing response shape.
 */
export async function resolveOwnerMembership(
  userId: string | undefined,
  agentUrl: string,
  deps: ResolveOwnerMembershipDeps,
): Promise<OwnerMembership> {
  if (!userId) return EMPTY_OWNER_MEMBERSHIP;
  const ownerOrgId = await deps.resolveOwnerOrgId(userId, agentUrl);
  if (!ownerOrgId) return EMPTY_OWNER_MEMBERSHIP;
  const orgRow = await deps.fetchOrgMembership(ownerOrgId);
  // A missing org row means the org_id resolved (so the user did own the
  // agent) but the organizations table doesn't have it — most likely a hard
  // delete that left member_profiles dangling. Treat that the same as
  // "ownership resolution failed" rather than as a logged-in owner of a
  // downgraded org. Otherwise the dashboard would silently leak the
  // deletion via "Your tier: —, ineligible".
  if (!orgRow) return EMPTY_OWNER_MEMBERSHIP;
  const tier = orgRow.membership_tier ?? null;
  const subStatus = orgRow.subscription_status ?? null;
  return {
    is_owner: true,
    membership_tier: tier,
    membership_tier_label: tierLabel(tier),
    subscription_status: subStatus,
    is_api_access_tier: isApiAccessTier(tier) && isActiveSubscriptionStatus(subStatus),
  };
}

/**
 * Returns true if the given user is eligible to submit content via
 * `propose_content` (Professional+ tier required).
 *
 * System users (`system:*` prefix) are always allowed — they are automated
 * pipelines that legitimately submit content on a cadence and bypass the
 * human-facing membership gate the same way they bypass the rate limiter.
 *
 * For all other users, resolves their primary organization and allows either:
 *   1. A direct API-access subscription in ACTIVE_SUBSCRIPTION_STATUSES that
 *      has not been canceled. This Perspectives-specific grace window does not
 *      widen the global AgenticAdvertising.org membership invariant.
 *   2. Strict effective membership inherited from a consenting paying parent.
 *
 * Returns false when the user has no primary organization or when either
 * condition is not met.
 */
export interface CheckContentSubmissionTierDeps {
  resolvePrimaryOrganization: (userId: string) => Promise<string | null>;
  resolveEffectiveMembership: typeof resolveEffectiveMembership;
  fetchDirectMembership: (orgId: string) => Promise<ContentSubmissionMembership | null>;
}

async function fetchDirectMembership(orgId: string): Promise<ContentSubmissionMembership | null> {
  const result = await getPool().query<MembershipTierRow & { subscription_canceled_at: Date | null }>(
    `SELECT ${MEMBERSHIP_TIER_COLUMNS.join(', ')}, subscription_canceled_at
     FROM organizations
     WHERE workos_organization_id = $1`,
    [orgId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    membership_tier: resolveMembershipTier(row),
    subscription_status: row.subscription_status,
    subscription_canceled_at: row.subscription_canceled_at,
  };
}

const DEFAULT_CONTENT_SUBMISSION_DEPS: CheckContentSubmissionTierDeps = {
  resolvePrimaryOrganization,
  resolveEffectiveMembership,
  fetchDirectMembership,
};

export async function checkContentSubmissionTier(
  userId: string,
  deps: CheckContentSubmissionTierDeps = DEFAULT_CONTENT_SUBMISSION_DEPS,
): Promise<boolean> {
  if (userId.startsWith('system:')) return true;

  const orgId = await deps.resolvePrimaryOrganization(userId);
  if (!orgId) return false;

  const directMembership = await deps.fetchDirectMembership(orgId);
  if (isContentSubmissionMembershipEligible(directMembership)) return true;

  const membership = await deps.resolveEffectiveMembership(orgId);

  // Preserve the existing hierarchy behavior, but only through the strict
  // active/non-canceled global membership resolver.
  return membership.is_member && isApiAccessTier(membership.membership_tier);
}
