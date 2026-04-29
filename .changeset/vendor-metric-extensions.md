---
"adcontextprotocol": minor
---

Add vendor-defined metric extensions — a structured pointer surface for
proprietary measurement metrics (attention scores, emissions per impression,
panel-based demographics, brand-lift surveys, in-flight attention panels)
that don't belong in the closed `available-metric.json` enum. Resolves the
closed/open enum question raised in #3460 with a structured surface instead
of opening the standard vocabulary to free-form strings.

**Why a parallel surface, not opening the enum.** Opening the closed enum
to free-form strings (e.g., `x_*` prefixed) would solve the asymmetry with
`delivery-metrics.json`'s `additionalProperties: true` posture but defeats
discovery: a buyer asking "I need attention measurement" can't query a
flat string namespace where every vendor uses a different name. A
structured extension gives the buyer a queryable axis — `vendor` (BrandRef)
— with `metric_id` as a second pin once vendors converge.

**Why the surface is intentionally thin.** Per-product extensions carry
only what the seller can credibly attest to: "I support this vendor's
metric." Everything else — category, methodology, standard alignment,
human-readable documentation, agent capabilities — is a property of the
vendor's metric definition, published once at the vendor's `brand.json`
`agents[type='measurement']` and queried out-of-band. Re-asserting that
metadata on every seller's extension is duplication that drifts.

**Schemas added.**

- `core/vendor-metric.json`: pointer descriptor `{ vendor: BrandRef, metric_id }`.
  No `metric_category`, no `standard_reference`, no `description`, no
  `documentation_url`, no inline `agent_url` — all of those live at the
  vendor and are resolved via `brand.json`. `additionalProperties: false`
  keeps the descriptor sealed.
- `core/vendor-metric-value.json`: the reported value
  `{ vendor, metric_id, value, unit?, measurable_impressions?, breakdown? }`.
  `measurable_impressions` is the coverage denominator (vendor measurement
  is rarely 100% — vendors only score impressions where their SDK fires
  or their panel matches). Absence means coverage is unspecified; do NOT
  compute a coverage rate or assume full coverage when absent. The
  `breakdown` slot is the only escape hatch for structured payloads
  beyond a single scalar (panel demographic breakouts, co-view ratios,
  incremental decompositions); the rest of the envelope is closed
  (`additionalProperties: false` on the value object). This pattern
  parallels the existing `viewability.measurable_impressions` field.

**Wired in.**

- `core/reporting-capabilities.json`: new `vendor_metrics` array (parallel
  to `available_metrics`). Semantic uniqueness key is
  `(vendor.domain, vendor.brand_id, metric_id)`; sellers MUST NOT declare
  the same vendor metric twice. JSON Schema `uniqueItems` is not used
  because BrandRef carries optional fields whose absence/presence would
  defeat deep-equal — uniqueness is enforced at build/validation time on
  the semantic key.
- `core/product-filters.json`: new `required_vendor_metrics` filter — each
  entry pins `vendor` and/or `metric_id`. Cross-vendor discovery (e.g.,
  "any attention measurement") is the buyer agent's responsibility: the
  agent resolves which vendors offer a category via the vendors'
  `brand.json` records, then enumerates them as filter entries. Same
  filter-not-fail convention as the other `required_*` filters.
- `core/delivery-metrics.json`: new `vendor_metric_values` array — emitted
  alongside standard scalars on every level that uses delivery-metrics
  (totals, by_package, by_creative, by_audience, etc.). One row per
  `(vendor.domain, vendor.brand_id, metric_id)` per reporting period.
  The parent `additionalProperties: true` is preserved so existing
  free-form vendor emissions remain conformant during migration.
- `docs/media-buy/task-reference/get_products.mdx`: new filter row.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: new
  `vendor_metric_values` bullet under per-package fields.
- `docs/media-buy/media-buys/optimization-reporting.mdx`: new
  Vendor-Defined Metrics section covering declaration, the brand.json
  discovery anchor for vendor-side metadata, the filter shape and
  cross-vendor discovery responsibility, the value emission shape with
  the coverage denominator, the standards-driven promotion path, and the
  v1 accountability scope.

**v1 accountability scope.** Standard `available_metrics` are subject to
the `missing_metrics` contract from #3472. Vendor metrics are advisory in
v1 — buyers verify out-of-band via `measurable_impressions` coverage and
direct calls to the vendor's measurement agent. The asymmetry reflects
what the seller can credibly attest to: SSPs typically don't have
proprietary measurement numbers in their delivery pipeline; those flow
from the vendor's own infrastructure.

**Promotion path.** When the industry converges on a metric via a
published standard, the spec adds it to the closed `available-metric.json`
enum and the vendor extensions become historical aliases. Anchored on
standards-body publication, not vendor-count thresholds.

**Backwards compatibility.** All additions are optional. Sellers without
vendor metrics see no change. The closed `available-metric.json` enum is
unchanged. `additionalProperties: true` is preserved on
`delivery-metrics.json` so existing free-form vendor emissions remain
conformant; the structured `vendor_metric_values` array is the
recommended path going forward.

Refs #3460. Closes the closed/open enum question.
