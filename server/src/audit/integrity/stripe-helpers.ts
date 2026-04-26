/**
 * Shared Stripe helpers for integrity invariants.
 *
 * The customer-fetch cache is the important one: three Phase-1 invariants
 * call `stripe.customers.retrieve` for the same set of orgs. Without
 * coalescing, a full /check run makes ~3N Stripe API calls when N would
 * suffice. The cache lives for one run (one InvariantContext lifetime).
 */
import type Stripe from 'stripe';
import type { InvariantContext } from './types.js';

/** True for the shape Stripe SDK throws on a 404 / resource_missing. */
export function isStripeNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; statusCode?: number };
  return e.code === 'resource_missing' || e.statusCode === 404;
}

/**
 * Retrieve a Stripe customer, sharing the result with any other invariant
 * in the same run that needs the same id. Caches successes only — failures
 * fall through to each invariant's own error handling so transient errors
 * surface as warnings, not silently-cached null results.
 *
 * The cache is opt-in via `ctx.stripeCustomerCache`. The runner creates a
 * fresh Map per run; tests that don't pass one fall back to direct calls.
 */
export async function getStripeCustomerCached(
  ctx: InvariantContext,
  customerId: string,
): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  const cache = ctx.stripeCustomerCache;
  if (cache) {
    const hit = cache.get(customerId);
    if (hit) return hit;
  }
  const customer = await ctx.stripe.customers.retrieve(customerId);
  if (cache) cache.set(customerId, customer);
  return customer;
}
