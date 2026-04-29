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
  company_icl: 'Member',
  company_leader: 'Leader',
};

export function tierLabel(tier: string | null | undefined): string | null {
  if (!tier) return null;
  return TIER_LABELS[tier] ?? tier;
}
