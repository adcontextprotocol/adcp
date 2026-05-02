/**
 * Membership product / lookup_key helpers.
 *
 * AAO billing has many Stripe products and prices, but only a subset drive
 * membership entitlement. Two signals identify them:
 *   1. The price `lookup_key` starts with `aao_membership_` or
 *      `aao_invoice_`. This is the modern convention.
 *   2. The price's product carries `metadata.category = "membership"`.
 *      Founding-era prices (Startup/SMB, Corporate) were created in the
 *      Stripe Dashboard before the lookup_key convention existed and rely
 *      on this metadata to classify. Without this fallback the founding
 *      cohort is invisible to `pickMembershipSub` and the integrity
 *      invariants — see Adzymic / Advertible / Bidcliq / Equativ (May 2026).
 *
 * Used by:
 *  - the integrity invariants that walk Stripe subs
 *  - the admin `/sync` endpoint when picking the right sub off a customer
 *  - the webhook handler when deciding whether subscription events update
 *    membership state
 *
 * The metadata path requires the price's `product` to be expanded by the
 * caller (otherwise Stripe returns a string id). Callers that don't expand
 * fall back to the lookup_key path, preserving prior behaviour.
 */
import type Stripe from 'stripe';

/** Price `lookup_key` prefixes that mark membership-bearing subscriptions. */
export const MEMBERSHIP_LOOKUP_KEY_PREFIXES = ['aao_membership_', 'aao_invoice_'] as const;

/** True when `lookup_key` corresponds to a membership-driving price. */
export function isMembershipLookupKey(lookupKey: string | null | undefined): boolean {
  if (!lookupKey) return false;
  return MEMBERSHIP_LOOKUP_KEY_PREFIXES.some((p) => lookupKey.startsWith(p));
}

/**
 * True when the price's product is tagged as a membership product via
 * `metadata.category = "membership"`. Returns false when `product` is a
 * string id (caller didn't expand) — the function is a hint for the
 * legacy-data path and is intentionally conservative when uncertain.
 */
export function isMembershipProductByMetadata(
  product: string | Stripe.Product | Stripe.DeletedProduct | null | undefined,
): boolean {
  if (!product || typeof product === 'string') return false;
  if ('deleted' in product && product.deleted) return false;
  const metadata = (product as Stripe.Product).metadata ?? {};
  return metadata.category === 'membership';
}

/** True when the first item on a subscription is a membership-driving price. */
export function isMembershipSub(sub: Stripe.Subscription): boolean {
  const price = sub.items.data[0]?.price;
  if (!price) return false;
  if (isMembershipLookupKey(price.lookup_key)) return true;
  return isMembershipProductByMetadata(price.product);
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

/**
 * Async picker that falls back to a per-product metadata fetch when
 * `lookup_key` doesn't match. Founding-era subs lack the lookup_key
 * convention, but the path Stripe needs to expand for product metadata
 * (`subscriptions.data.items.data.price.product`) exceeds the 4-level
 * expansion limit on `subscriptions.list`. So when the fast lookup_key
 * pass yields nothing, fall back to retrieving the product for each
 * candidate sub with one extra round-trip per non-matching sub.
 *
 * Synchronous `pickMembershipSub` remains the right call for invariants
 * that walk every sub on the account (cheap by lookup_key, no per-sub
 * fetches at scale). This async variant is for the admin `/sync` path
 * where we want to repair a single org's row.
 */
export async function pickMembershipSubWithProductFetch(
  subscriptions: readonly Stripe.Subscription[],
  fetchProduct: (productId: string) => Promise<Stripe.Product | Stripe.DeletedProduct>,
): Promise<Stripe.Subscription | null> {
  const fast = pickMembershipSub(subscriptions);
  if (fast) return fast;

  // Fall back to product-metadata classification on subs whose price
  // has a `product` id but no membership lookup_key.
  const candidates: Stripe.Subscription[] = [];
  for (const sub of subscriptions) {
    const price = sub.items.data[0]?.price;
    if (!price) continue;
    const productId = typeof price.product === 'string' ? price.product : null;
    if (!productId) continue;
    try {
      const product = await fetchProduct(productId);
      if (isMembershipProductByMetadata(product)) {
        candidates.push(sub);
      }
    } catch {
      // Skip a sub whose product can't be retrieved; the lookup-key path
      // already returned nothing for it. We don't want one bad fetch to
      // tank the whole sync.
    }
  }
  if (candidates.length === 0) return null;
  return candidates.find((s) => s.status === 'active') ?? candidates[0];
}

/**
 * Per-sub variant of the same fast-path / product-fetch pattern. Used
 * when walking a stream of subs (the `stripe-sub-reflected-in-org-row`
 * invariant) where we filter rather than pick. `productCache` is shared
 * across calls so a Stripe product backing many founding-era subs costs
 * one `products.retrieve`, not one per sub.
 */
export async function isMembershipSubWithProductFetch(
  sub: Stripe.Subscription,
  fetchProduct: (productId: string) => Promise<Stripe.Product | Stripe.DeletedProduct>,
  productCache?: Map<string, Stripe.Product | Stripe.DeletedProduct>,
): Promise<boolean> {
  if (isMembershipSub(sub)) return true;
  const price = sub.items.data[0]?.price;
  if (!price) return false;
  const productId = typeof price.product === 'string' ? price.product : null;
  if (!productId) return false;
  const cached = productCache?.get(productId);
  if (cached) return isMembershipProductByMetadata(cached);
  try {
    const product = await fetchProduct(productId);
    productCache?.set(productId, product);
    return isMembershipProductByMetadata(product);
  } catch {
    return false;
  }
}
