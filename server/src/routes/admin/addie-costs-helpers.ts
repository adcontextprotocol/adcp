/**
 * Pure helpers for the Addie cost-cap admin view (#2945). Kept in a
 * separate module from the route file so unit tests can import the
 * classifiers without pulling the auth-middleware chain (which requires
 * WorkOS env vars at import time).
 */

const MICROS_PER_DOLLAR = 1_000_000;

export type Namespace = 'email' | 'slack' | 'mcp' | 'tavus' | 'anon' | 'workos' | 'unknown';

/**
 * Fallback tier inference when we can't join to organizations (every
 * namespace except `workos`). Anonymous-shaped namespaces get the
 * tightest cap; slack (which *could* be a real member but wasn't mapped
 * at call time) gets member_free.
 */
export const NAMESPACE_FALLBACK_TIER: Record<Namespace, 'anonymous' | 'member_free' | 'member_paid'> = {
  email: 'anonymous',
  mcp: 'anonymous',
  tavus: 'anonymous',
  anon: 'anonymous',
  slack: 'member_free',
  workos: 'member_free',
  unknown: 'member_free',
};

/**
 * Tier inference for a single scope's display row. `member_paid` only
 * applies when we can verify an active subscription via a bare WorkOS
 * user id join; everywhere else we fall back to the namespace-level
 * inference so the displayed cap is a defensible upper bound, not a
 * false claim (e.g. we don't show `member_paid` for an `email:<hash>`
 * scope just because it happens to be a high spender).
 */
export function inferDisplayTier(
  namespace: Namespace,
  hasActiveSubscription: boolean | null,
): 'anonymous' | 'member_free' | 'member_paid' {
  if (hasActiveSubscription === true) return 'member_paid';
  return NAMESPACE_FALLBACK_TIER[namespace];
}

/**
 * Classify a scope key into its namespace. Kept in sync with the SQL
 * `NAMESPACE_CASE` expression in addie-costs.ts — the two classifiers
 * must agree so the admin page can't claim a namespace count that the
 * leaderboard can't reproduce.
 */
export function classifyScopeKey(key: string): Namespace {
  if (key.startsWith('email:')) return 'email';
  if (key.startsWith('slack:')) return 'slack';
  if (key.startsWith('mcp:')) return 'mcp';
  if (key.startsWith('tavus:ip:')) return 'tavus';
  if (key.startsWith('anon:')) return 'anon';
  if (key.startsWith('user_')) return 'workos';
  return 'unknown';
}

export function microsToUsd(micros: number): number {
  return Math.round((micros / MICROS_PER_DOLLAR) * 100) / 100;
}
