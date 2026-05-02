---
"adcontextprotocol": minor
---

Reconcile the metric vocabulary across the protocol. Closes #3858 (deprecate `metric-type` enum on `performance-feedback`); substantially addresses #3863 (four-parallel-enums cleanup) — full sub-enum restructuring deferred to a follow-up minor.

**Problem.** Four parallel metric enums grew independently with overlapping but inconsistent vocabularies:

- `available-metric.json` (30 values) — closed delivery enum used by `committed_metrics`, `required_metrics`, `reporting_capabilities.available_metrics`
- `forecastable-metric.json` (15 values) — forecast-time enum, mostly mirrors `available-metric` plus deltas (`audience_size`, `measured_impressions`, `grps`, `reach`, `frequency`)
- `performance-standard-metric.json` (5 values) — verification subset (`viewability`, `ivt`, `completion_rate`, `brand_safety`, `attention_score`)
- `metric-type.json` (8 values) — legacy `performance-feedback` enum mixing metrics, verification, and attribution into one list (`overall_performance`, `conversion_rate`, `brand_lift`, `click_through_rate`, `completion_rate`, `viewability`, `brand_safety`, `cost_efficiency`)

**Changes.**

### `performance-feedback.json` (#3858)

- Adds `metric: { scope, metric_id, qualifier? }` field — the discriminated row shape symmetric with `committed_metrics` and `metric_aggregates`. Preferred over the legacy `metric_type` field for new implementations.
- Marks `metric_type` as **deprecated** in description; retained as `required` for one-minor backwards compatibility (existing implementations continue to work). Removed at the next major when `metric` becomes required.
- When both `metric` and `metric_type` are present, consumers MUST use `metric` for dispatch.
- Standard-scope `metric` entries support `qualifier.viewability_standard` (MRC vs GroupM) and `qualifier.completion_source` (seller vs vendor attested). Vendor-scope entries carry the BrandRef pattern.

### `metric-type.json` (#3858)

- Marked deprecated in title and description.
- Description carries a migration table mapping each legacy value to its replacement on the new `metric` field. Meta-bucket values (`overall_performance`, `cost_efficiency`) have no replacement — they were never well-defined and the migration encourages specific metrics or omitting the field.

### `forecastable-metric.json` (#3863, partial)

- Description clarifies which values mirror `available-metric.json` (the canonical delivery vocabulary) and which are forecast-only deltas. Forecast-only values graduate into `available-metric.json` if and when the industry converges on adding them to delivery reporting.
- No schema shape change in this minor; the cross-reference is documented in prose.

### `performance-standard-metric.json` (#3863, partial)

- Description clarifies the verification-subset role and the relationship to `available-metric.json` (shared values mirror; verification-only values like `ivt`, `brand_safety`, `attention_score` flow through `vendor_metric_values` or vendor-scope `committed_metrics` entries).
- No schema shape change.

### `provide_performance_feedback.mdx`

- Request parameters table updated with the new `metric` field row and the `metric_type` deprecation marker.
- Disambiguates the top-level `vendor` field (source of the feedback) from the nested `metric.vendor` field (vendor that defines the metric). Often the same; can differ.

**Migration.**

Implementations using `performance-feedback.metric_type` continue to work unchanged for one minor. New implementations SHOULD populate both fields during the transition window: `metric_type` for backwards-compat with consumers reading the legacy field, `metric` as the preferred dispatch surface. At the next major (4.0), `metric_type` is removed and `metric` becomes required.

**Backwards compatibility.** Additive (new field on performance-feedback). Existing consumers that ignore the new field continue to work. Deprecated `metric_type` is still required at the schema level for one minor.

**What's deferred** (#3863 follow-up). Forecast-only sub-enum extraction (split `forecastable-metric` into `delivery-metrics-shared` + `forecast-only`) and `performance-standard-metric` cross-reference enforcement at the schema level. Both are mechanical follow-ups; the prose description updates ship the conceptual reconciliation now and unblock the deprecation path on `metric-type`.

Closes #3858. Substantially addresses #3863.
