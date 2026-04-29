---
"adcontextprotocol": minor
---

Add vendor-defined metric extensions — a structured surface for proprietary
measurement metrics (Adelaide attention, Scope3 emissions, Nielsen DAR
demographics, IAS/DV custom quality, brand-lift, incrementality, in-flight
attention panels) that don't belong in the closed `available-metric.json`
enum. Resolves the closed/open enum question raised in #3460.

**Why a parallel surface, not opening the enum.** Opening the closed enum
to free-form strings (e.g., `x_*` prefixed) would solve the asymmetry with
`delivery-metrics.json`'s `additionalProperties: true` posture but defeats
discovery: a buyer asking "I need attention measurement" can't query a
flat string namespace where Adelaide writes `x_adelaide_attention_units`,
Lumen writes `x_lumen_attention_seconds`, and TVision writes
`x_tv_co_view_attention`. A structured extension gives the buyer two
queryable axes — `vendor` (BrandRef) and `metric_category` (an industry
classification) — with the standard `metric_name` as a third pin once
vendors converge.

**Schemas added.**

- `core/vendor-metric.json`: descriptor of a vendor-defined metric.
  `{ vendor: BrandRef, metric_name, metric_category?, standard_reference? }`.
  No `agent_url` — measurement-agent discovery defers to the vendor's
  `brand.json` `agents[type='measurement']` array, matching the existing
  convention in `measurement-terms.json` and `performance-standard.json`.
- `core/vendor-metric-value.json`: the reported value.
  `{ vendor, metric_name, value, unit?, measurable_impressions?, breakdown? }`.
  `measurable_impressions` is the coverage denominator — vendor measurement
  is rarely 100% (Adelaide only scores impressions where their SDK fires,
  Nielsen DAR only matches panel-resolved impressions, IAS/DV only measure
  where their tag is present). This pattern parallels the existing
  `viewability.measurable_impressions` field that has handled vendor
  coverage in the IAS/DV/MRC ecosystem for over a decade. The `breakdown`
  slot accommodates structured payloads beyond a single scalar (Nielsen
  demographic breakouts, TVision co-view ratios, iSpot incremental
  decomposition).
- `enums/measurement-category.json`: nine-value classification — `attention`,
  `brand_lift`, `incrementality`, `audience`, `reach`, `creative_quality`,
  `emissions`, `outcomes`, `other`. Tracks the established
  measurement-vendor space (IAB Attention Task Force, MRC viewability,
  GARM/Ad Net Zero emissions, brand-lift / incrementality / audience
  verticals).

**Wired in.**

- `core/reporting-capabilities.json`: new `vendor_metrics` array (parallel
  to `available_metrics`) declaring vendor-defined metrics on the product.
- `core/product-filters.json`: new `required_vendor_metrics` filter — each
  entry pins `vendor`, `metric_name`, `metric_category`, or any
  combination (at least one of the three). AND across entries; cross-vendor
  queries via `metric_category` (recommended) or bare `metric_name`. Same
  filter-not-fail convention as the other `required_*` filters.
- `core/delivery-metrics.json`: new `vendor_metric_values` array — emitted
  alongside standard scalars on every level that uses delivery-metrics
  (totals, by_package, by_creative, by_audience, etc.). The parent
  `additionalProperties: true` is preserved so existing free-form vendor
  emissions remain conformant during migration.
- `docs/media-buy/task-reference/get_products.mdx`: new filter row.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: new
  `vendor_metric_values` bullet under per-package fields.
- `docs/media-buy/media-buys/optimization-reporting.mdx`: new
  Vendor-Defined Metrics section covering declaration, discovery,
  reporting, the brand.json discovery anchor, the standards-driven
  promotion path, and the v1 accountability scope.

**v1 accountability scope.** Standard `available_metrics` are subject to
the `missing_metrics` contract from #3472. Vendor metrics are advisory in
v1 — buyers verify out-of-band via `measurable_impressions` coverage and
direct calls to the vendor's measurement agent. The asymmetry reflects
what the seller can credibly attest to: SSPs typically don't have
Adelaide/Scope3 numbers in their delivery pipeline; those flow from the
vendor's own infrastructure.

**Promotion path.** When the industry converges on a metric via a
published standard (IAB Attention Measurement Guidelines, MRC variants,
GARM emissions framework), the spec adds it to the closed
`available-metric.json` enum and the vendor extensions become historical
aliases. The `standard_reference` field on each vendor metric anchors
promotion to standards-body publications, not to ad-hoc vendor
convergence counts.

**Backwards compatibility.** All additions are optional. Sellers without
vendor metrics see no change. The closed `available-metric.json` enum is
unchanged. `additionalProperties: true` is preserved on
`delivery-metrics.json` so existing free-form vendor emissions remain
conformant; the structured `vendor_metric_values` array is the
recommended path going forward.

Refs #3460. Closes the closed/open enum question.
