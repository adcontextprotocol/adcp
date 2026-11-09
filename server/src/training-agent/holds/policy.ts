/**
 * Hold policy (`core/hold-policy.json`, experimental `media_buy.hold_policy`):
 * duration arithmetic and the draft-derivation rules from refine_proposals.mdx
 * ("Drafts bind; products plan").
 */

export interface HoldPolicy {
  available: boolean;
  min_duration?: string;
  max_duration?: string;
  extendable?: boolean;
  max_total_duration?: string;
  rankable?: boolean;
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Elapsed milliseconds of a hold-policy duration. A day is exactly 24 hours
 * on the UTC instant, so `P1D` equals `PT24H`. */
export function durationMs(value: string): number {
  const match = DURATION.exec(value);
  if (!match || value === 'P' || value.endsWith('T')) throw new Error(`Unsupported hold duration ${value}`);
  const [d, h, m, s] = match.slice(1).map(part => Number(part ?? 0));
  return (((d * 24 + h) * 60 + m) * 60 + s) * 1000;
}

/** The agent's default for a product or draft without `hold_policy`: the
 * training agent does not declare `hold_semantics`, so `inventory_hold`. */
export const AGENT_DEFAULT_POLICY: Readonly<HoldPolicy> = Object.freeze({ available: true });

interface Bound {
  ms: number;
  text: string;
}

function bounds(policies: readonly HoldPolicy[], key: 'min_duration' | 'max_duration' | 'max_total_duration'): Bound[] {
  return policies
    .map(policy => policy[key])
    .filter((value): value is string => typeof value === 'string')
    .map(text => ({ ms: durationMs(text), text }));
}

const smallest = (values: Bound[]): Bound | undefined => values.reduce<Bound | undefined>(
  (best, value) => (best === undefined || value.ms < best.ms ? value : best),
  undefined,
);
const largest = (values: Bound[]): Bound | undefined => values.reduce<Bound | undefined>(
  (best, value) => (best === undefined || value.ms > best.ms ? value : best),
  undefined,
);

/**
 * The binding policy for a draft allocating products with these effective
 * policies:
 *
 * - `available` is false if any product is non-holdable (no partial holds);
 * - `min_duration` and `max_duration` never exceed any product's
 *   `max_duration`, and `max_total_duration` never exceeds any product's;
 * - `extendable` only if every product is extendable;
 * - `rankable` if any product is rankable.
 *
 * The seller's choice within those rules: the longest minimum any product
 * promises, capped at the shortest maximum, so the draft promises as much as
 * every product allows and no more.
 */
export function deriveDraftPolicy(productPolicies: readonly HoldPolicy[]): HoldPolicy {
  const policies = productPolicies.length > 0 ? productPolicies : [AGENT_DEFAULT_POLICY];
  if (policies.some(policy => !policy.available)) return { available: false };
  const extendable = policies.every(policy => policy.extendable === true);
  const total = extendable ? smallest(bounds(policies, 'max_total_duration')) : undefined;
  let max = smallest(bounds(policies, 'max_duration'));
  if (max && total && max.ms > total.ms) max = total;
  let min = largest(bounds(policies, 'min_duration'));
  if (min && max && min.ms > max.ms) min = max;
  const rankable = policies.some(policy => policy.rankable === true);
  return {
    available: true,
    ...(min && { min_duration: min.text }),
    ...(max && { max_duration: max.text }),
    ...(extendable && { extendable: true }),
    ...(total && { max_total_duration: total.text }),
    ...(rankable && { rankable: true }),
  };
}

/** min_duration <= max_duration <= max_total_duration, after normalizing. */
export function durationsOrdered(policy: HoldPolicy): boolean {
  const ordered = [policy.min_duration, policy.max_duration, policy.max_total_duration]
    .filter((value): value is string => typeof value === 'string')
    .map(durationMs);
  return ordered.every((value, index) => index === 0 || ordered[index - 1]! <= value);
}
