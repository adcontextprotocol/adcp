/**
 * Container-subsumption rule from `enums/available-metric.json`: a container
 * token (`viewability`, `quartile_data`) subsumes its leaf identities for
 * every metric set operation — capability declaration, `required_metrics`
 * filtering, format `reported_metrics` intersection, and `requested_metrics`
 * selection. Declaring the container satisfies a requirement or request for
 * any of its leaves; a leaf declaration does not imply sibling leaves or the
 * carrier's non-numeric fields. `dooh_metrics` and `time_based_views` are
 * containers too, but the enum defines no addressable leaf identities under
 * them, so they never appear on either side of `CONTAINER_LEAVES`.
 */
const CONTAINER_LEAVES: Readonly<Record<string, readonly string[]>> = {
  viewability: ['viewable_rate', 'viewable_impressions', 'measurable_impressions', 'viewed_seconds'],
  quartile_data: ['quartile_25', 'quartile_50', 'quartile_75', 'quartile_100'],
};

const LEAF_TO_CONTAINER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CONTAINER_LEAVES).flatMap(([container, leaves]) => leaves.map(leaf => [leaf, container])),
);

/**
 * Every top-level field name that can appear directly on a `delivery-metrics.json`
 * shaped object (totals, by_package rows, by_creative rows, etc.). Mirrors the
 * `available-metric.json` enum minus the leaf identities, which never appear as
 * flat keys — they resolve to their carrier object instead.
 */
export const METRIC_FIELD_NAMES: ReadonlySet<string> = new Set([
  'impressions', 'spend', 'clicks', 'ctr', 'views', 'completed_views', 'completion_rate',
  'conversions', 'conversion_value', 'commissionable_value', 'roas', 'cost_per_acquisition',
  'new_to_brand_rate', 'leads', 'reach', 'frequency', 'grps', 'engagements', 'engagement_rate',
  'follows', 'saves', 'profile_visits', 'viewability', 'quartile_data', 'time_based_views',
  'dooh_metrics', 'ooh_metrics', 'cost_per_click', 'cost_per_completed_view', 'cpm', 'downloads',
  'units_sold', 'new_to_brand_units', 'plays', 'incremental_sales_lift', 'brand_lift',
  'foot_traffic', 'conversion_lift', 'brand_search_lift',
]);

/** Metrics that `requested_metrics` narrowing MUST always include, per the field's description. */
export const ALWAYS_INCLUDED_METRICS: readonly string[] = ['impressions', 'spend'];

/**
 * Whether a product's declared metric set satisfies a single required metric
 * token, applying container subsumption. Declaring the container satisfies a
 * leaf requirement; a declared leaf never satisfies a different (sibling)
 * leaf or the container itself.
 */
export function satisfies(declared: readonly string[], required: string): boolean {
  if (declared.includes(required)) return true;
  const container = LEAF_TO_CONTAINER[required];
  return container !== undefined && declared.includes(container);
}

/** Whether a declared metric set satisfies every entry in a required list (AND across entries). */
export function satisfiesAll(declared: readonly string[], required: readonly string[]): boolean {
  return required.every(metric => satisfies(declared, metric));
}

/**
 * Resolves a requested metric token to the field name that carries it in a
 * response object: a leaf identity resolves to its canonical carrier
 * container (e.g. `viewable_rate` -> `viewability`); every other token
 * (including containers) resolves to itself.
 */
export function resolveToCarrier(token: string): string {
  return LEAF_TO_CONTAINER[token] ?? token;
}

/**
 * Resolves a `requested_metrics` list to the set of top-level field names a
 * response object should keep: every requested token resolved through its
 * carrier, plus `impressions` and `spend`, which `requested_metrics` MUST
 * always include regardless of what was asked for.
 */
export function resolveRequestedMetrics(requested: readonly string[]): Set<string> {
  const resolved = new Set<string>(ALWAYS_INCLUDED_METRICS);
  for (const metric of requested) resolved.add(resolveToCarrier(metric));
  return resolved;
}

/**
 * Narrows a metrics-bearing object (totals, a by_package row, a breakdown
 * row) to the resolved `keep` set. Only keys in `METRIC_FIELD_NAMES` are
 * subject to narrowing — structural/identity fields (package_id, currency,
 * pricing_model, missing_metrics, etc.) always pass through untouched.
 * `keep === undefined` means no narrowing was requested; the record is
 * returned unchanged.
 */
export function narrowMetricsRecord<T extends Record<string, unknown>>(
  record: T,
  keep: Set<string> | undefined,
): T {
  if (!keep) return record;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (METRIC_FIELD_NAMES.has(key) && !keep.has(key)) continue;
    result[key] = value;
  }
  return result as T;
}
