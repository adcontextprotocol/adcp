/**
 * Membership product / lookup_key helpers.
 *
 * AAO billing has many Stripe products and prices, but only a subset drive
 * membership entitlement. The price `lookup_key` distinguishes them by
 * convention — every membership price starts with `aao_membership_` or
 * `aao_invoice_`. This module is the single source of truth for that
 * convention; consumers should never re-encode the prefix list inline.
 *
 * Used by:
 *  - the integrity invariant that walks Stripe subs (so we don't flag drift
 *    on non-membership subs that don't drive entitlement)
 *  - the admin `/sync` endpoint (so we don't pick a non-membership sub off
 *    a customer that happens to have one + a real membership)
 *  - the webhook handler when deciding whether subscription events update
 *    membership state
 */
import type Stripe from 'stripe';

/** Price `lookup_key` prefixes that mark membership-bearing subscriptions. */
export const MEMBERSHIP_LOOKUP_KEY_PREFIXES = ['aao_membership_', 'aao_invoice_'] as const;

/** True when `lookup_key` corresponds to a membership-driving price. */
export function isMembershipLookupKey(lookupKey: string | null | undefined): boolean {
  if (!lookupKey) return false;
  return MEMBERSHIP_LOOKUP_KEY_PREFIXES.some((p) => lookupKey.startsWith(p));
}

/** True when the first item on a subscription is a membership-driving price. */
export function isMembershipSub(sub: Stripe.Subscription): boolean {
  return isMembershipLookupKey(sub.items.data[0]?.price?.lookup_key);
}

/**
 * Pick the membership subscription off a customer's subscription list.
 *
 * Returns `null` when no item is a membership sub. When multiple match
 * (which is a violation of `one-active-stripe-sub-per-org` — both can't
 * legitimately drive entitlement) returns the first matching, preferring
 * `active` over other live statuses for stability.
 *
 * Replaces the `subscriptions.data[0]` pattern that misbehaves when a
 * customer has a non-membership sub stacked alongside a real membership —
 * the order is not guaranteed by Stripe and the wrong pick can overwrite
 * a paying member's row with a one-off product's status.
 */
export function pickMembershipSub(subscriptions: readonly Stripe.Subscription[]): Stripe.Subscription | null {
  const memberships = subscriptions.filter(isMembershipSub);
  if (memberships.length === 0) return null;
  return memberships.find((s) => s.status === 'active') ?? memberships[0];
}
