---
"adcontextprotocol": minor
---

Unify outcome measurement into the same primitives as the rest of the measurement surface — outcome metrics live in `available-metric.json`, attribution methodology and window live in the qualifier slot, and `outcome_measurement` as a dedicated field is deprecated. Closes #3857.

**The conceptual collapse.** Before this minor, the protocol had two surfaces describing overlapping subject matter:

- `delivery-metrics.json` carried outcome scalars (`conversions`, `conversion_value`, `roas`, `cost_per_acquisition`, `units_sold`, etc.) as part of seller-reported delivery — already the audit-flagged "attribution-derived but seller-reported" hybrid.
- `core/outcome-measurement.json` (a separate field on `product`) carried business outcome capabilities (`incremental_sales_lift`, `brand_lift`, `foot_traffic`) as free-form strings with implicit vendor identity.

These were always the same conceptual category — seller-as-measurement-vendor outcome metrics — split across two surfaces because the protocol predated the unified row-shape vocabulary established by #3576 / #3848. With the qualifier slot proven generalizable (#3877's `completion_source` joining `viewability_standard`), the two surfaces collapse cleanly.

**Schemas added.**

- `enums/attribution-methodology.json`: closed enum `["deterministic_purchase", "probabilistic", "panel_based", "modeled"]` covering the methodology axis. `deterministic_purchase` is the retail-media closed-loop default (Walmart Connect / Kroger Precision / Amazon DSP); `modeled` covers MMM and clean-room outputs; `panel_based` covers Nielsen / comScore / Edison; `probabilistic` covers statistical match without a 1:1 identifier.

**Schemas updated.**

- `enums/available-metric.json`: adds `incremental_sales_lift`, `brand_lift`, `foot_traffic`, `conversion_lift`, `brand_search_lift` to the closed delivery vocabulary. Existing outcome scalars (`conversions`, `conversion_value`, `roas`, etc.) cover the rest. **Note: no separate `attributed_sales` entry** — that's `conversion_value` with `qualifier.attribution_methodology: "deterministic_purchase"`. The unified pattern handles the deterministic/probabilistic/modeled split via qualifier rather than parallel metric IDs.
- `core/delivery-metrics.json`: adds scalar properties for the five new outcome metrics, with descriptions clarifying which methodologies typically apply.
- **Qualifier slot expanded with two new keys** at all five sites (`core/package.json` `committed_metrics`, `media-buy/package-request.json` buyer-side `committed_metrics`, `media-buy/get-media-buy-delivery-response.json` `metric_aggregates` and `missing_metrics`, `core/performance-feedback.json` `metric`):
  - `attribution_methodology` — closed string enum (`$ref attribution-methodology.json`)
  - `attribution_window` — structured duration (`$ref duration.json`). **First object-valued qualifier key** — the slot was previously string-enum-only; this PR establishes that qualifier values can be structured. Window isn't disambiguating "which version of the metric" the way `viewability_standard` does — it's parameterizing — but the join-on-`(metric_id, qualifier)` pattern handles the same-metric-different-window case correctly so the placement works.
- `core/outcome-measurement.json`: title and description marked **deprecated**. Description carries a migration table mapping legacy field semantics to the unified pattern. Schema retained as-is for one-minor backwards compatibility.
- `core/product.json` `outcome_measurement` field description marked deprecated, points at the new pattern.

**Doc updates.**

- `docs/media-buy/commerce-media.mdx`: "How products declare it" section rewritten to show the new pattern (`reporting_capabilities.available_metrics` + qualifier on commit) alongside the legacy `outcome_measurement` field for the transition window. Existing example payloads continue to use the legacy field — they validate during the deprecation window.
- `docs/media-buy/product-discovery/media-products.mdx`: `outcome_measurement` field description updated with deprecation note.
- `docs/media-buy/task-reference/create_media_buy.mdx`: qualifier section adds `attribution_methodology` and `attribution_window` with their conditional-required semantics.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: qualifier vocabulary section names all four keys.

**Migration.**

Retail-media sellers using `outcome_measurement` continue to work for one minor. New implementations declare outcome capabilities via `reporting_capabilities.available_metrics` (the same surface used for impressions, conversions, ROAS today) and pin attribution methodology + window via `qualifier` on `committed_metrics` / `metric_aggregates`. Seller-as-measurement-vendor remains the dominant retail-media topology — vendor identity is implicit (the seller) when no separate `performance_standards.vendor` BrandRef is set.

**What's deferred.**

`reporting_frequency` and `reporting_format` (the `outcome_measurement.reporting` field's dimensions) move to a follow-up extension on `reporting_capabilities` — they're a property of the seller's reporting infrastructure (daily API, weekly dashboard) rather than a per-metric concern, so they don't belong entangled with the metric definition. Existing `outcome_measurement.reporting` payloads continue to work for one minor.

**Backwards compatibility.** Additive (new metrics, new qualifier keys, new enum). Deprecated `outcome_measurement` field continues to validate. Removed at the next major when the unified pattern is canonical.

Closes #3857.
