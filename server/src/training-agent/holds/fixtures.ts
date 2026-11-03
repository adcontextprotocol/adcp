/**
 * Hold-policy fixtures for the training agent's catalog (experimental
 * `media_buy.hold_policy`, #8181).
 *
 * Kept beside the catalog rather than inside it, so the catalog stays
 * release-neutral and the policies reach only callers served AdCP 3.3. Each
 * entry is the product's planning hint and says how a hold on the product
 * contends for inventory:
 *
 * - `product`: the product is one sellable unit (a sponsorship, a frame), so
 *   every hold on it is a hold on the same slot.
 * - `installment`: each scheduled installment (a creator's upcoming video) is
 *   its own slot, and the hold lists them in `holds`.
 *
 * Products without an entry take the agent default (`inventory_hold`, so
 * `{ available: true }`) and model unconstrained inventory: holds on them are
 * placed and reported but never contend. Only fixture products can be
 * contended, which keeps the demonstration catalog that storyboards book
 * repeatedly from running out.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { durationsOrdered, durationMs, type HoldPolicy } from './policy.js';

export interface HoldFixture {
  policy: HoldPolicy;
  contention: 'product' | 'installment';
}

const CREATOR_SLOT: HoldFixture = {
  // A creator slot is held while the creator confirms: at least two days,
  // at most five per hold, extendable up to three weeks in total but never
  // past the slot's booking deadline. Several brands can queue on one slot.
  policy: {
    available: true,
    min_duration: 'P2D',
    max_duration: 'P5D',
    extendable: true,
    max_total_duration: 'P21D',
    rankable: true,
  },
  contention: 'installment',
};

const CREATOR_PRODUCTS = [
  'juniper_vale', 'tobias_quill', 'nadia_ferro', 'kenji_arden', 'sol_marquez',
  'priya_halden', 'dex_okafor', 'lena_brightwater', 'ravi_castellan', 'odette_moreau',
].map(slug => `creatorloop_creator_${slug}`);

export const HOLD_FIXTURES: Readonly<Record<string, Readonly<HoldFixture>>> = Object.freeze({
  // Exclusive and not rankable: a station sponsorship has one sponsor, so a
  // second buyer gets hold_unavailable while the first hold stands.
  crestline_radio_premium: {
    policy: { available: true, min_duration: 'P1D', max_duration: 'P3D' },
    contention: 'product',
  },
  // Ranked: out-of-home frames are commonly held first, second, and third.
  streetlevel_premium: {
    policy: { available: true, min_duration: 'P2D', max_duration: 'P7D', rankable: true },
    contention: 'product',
  },
  // Not holdable: an auction product has nothing to reserve, so finalize
  // commits terms only.
  beacon_search_standard: {
    policy: { available: false },
    contention: 'product',
  },
  // Exclusive and extendable: influencer packages wait on talent approval.
  trendsettr_premium: {
    policy: { available: true, min_duration: 'P1D', max_duration: 'P3D', extendable: true, max_total_duration: 'P10D' },
    contention: 'product',
  },
  ...Object.fromEntries(CREATOR_PRODUCTS.map(productId => [productId, CREATOR_SLOT])),
});

/**
 * Hold policies of products a storyboard seeded through comply_test_controller
 * (`fixtures.products[].hold_policy`), for the request in flight. A seeded
 * product replaces a catalog product with the same ID, as the seeded overlay
 * does for every other product field, and contends per product.
 */
const seededScope = new AsyncLocalStorage<ReadonlyMap<string, Readonly<HoldFixture>>>();

export function runWithSeededHoldFixtures<T>(
  seeded: ReadonlyMap<string, Readonly<HoldFixture>>,
  fn: () => Promise<T>,
): Promise<T> {
  return seeded.size > 0 ? seededScope.run(seeded, fn) : fn();
}

const DURATION_KEYS = ['min_duration', 'max_duration', 'max_total_duration'] as const;

/**
 * The hold fixture a seeded product declares, or undefined when its
 * `hold_policy` is absent or not a policy the schema allows: `available` is
 * required, durations parse and are ordered, `extendable` and `rankable` are
 * booleans, and a non-holdable policy declares nothing else.
 */
export function seededHoldFixture(product: unknown): HoldFixture | undefined {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return undefined;
  const raw = (product as { hold_policy?: unknown }).hold_policy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.available !== 'boolean') return undefined;
  if (!value.available) {
    return Object.keys(value).length === 1 ? { policy: { available: false }, contention: 'product' } : undefined;
  }
  const policy: HoldPolicy = { available: true };
  for (const key of DURATION_KEYS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string') return undefined;
    try {
      if (durationMs(value[key] as string) <= 0) return undefined;
    } catch {
      return undefined;
    }
    policy[key] = value[key] as string;
  }
  for (const key of ['extendable', 'rankable'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') return undefined;
    policy[key] = value[key] as boolean;
  }
  if (policy.max_total_duration && policy.extendable !== true) return undefined;
  return durationsOrdered(policy) ? { policy, contention: 'product' } : undefined;
}

export function holdFixture(productId: string): Readonly<HoldFixture> | undefined {
  const seeded = seededScope.getStore()?.get(productId);
  if (seeded) return seeded;
  return Object.prototype.hasOwnProperty.call(HOLD_FIXTURES, productId) ? HOLD_FIXTURES[productId] : undefined;
}
