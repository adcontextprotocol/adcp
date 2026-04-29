---
"adcontextprotocol": minor
---

Add optional `filter_diagnostics` block to `get_products` response —
non-fatal observability for the filter-not-fail empty-result UX gap.
Closes #3482.

**The gap.** Every `required_*` filter in `product-filters.json` is
silent-exclude semantics (the established AdCP convention; matches
OpenRTB / SSP capability discovery patterns). When the result list is
empty or unexpectedly small, the buyer can't distinguish:

- "No inventory matches the brief"
- "`required_metrics` excluded everything"
- "`required_geo_targeting` excluded everything"
- "`budget_range` had no overlap with available products"

Today the buyer must blindly relax filters one at a time to discover
which one was unsatisfiable. Both pre-build expert reviewers (protocol
and product) independently flagged this as the buyer-side observability
gap on PR #3472 (`required_metrics`).

**Shape.** Optional, additive, observability — not error reporting:

```json
{
  "products": [],
  "filter_diagnostics": {
    "total_candidates": 47,
    "excluded_by": {
      "required_metrics": { "count": 31, "values": ["completed_views"] },
      "required_geo_targeting": { "count": 9 },
      "budget_range": { "count": 7 }
    }
  }
}
```

- `total_candidates`: integer baseline before filters applied. May be
  sampled or capped at large catalogs.
- `excluded_by`: keyed by filter property name as it appears in the
  request's `filters` object. Each value carries `count` (required),
  optional `values` (the specific filter values that contributed to
  exclusions), and optional `notes` (human-readable narrative).

**Counts only — never product names.** Listing excluded products would
leak competitive intelligence about adjacent campaigns or seller
inventory. Counts plus `values` (the filter inputs that did the
excluding, not the products that got excluded) is enough for triage
without that leakage.

**Counting semantics intentionally loose.** Sellers vary on whether to
count products excluded by ANY filter or ONLY by this filter. The spec
documents the field as approximate — buyers SHOULD treat counts as
triage signal, not exact accounting. Tightening this would force every
seller to implement the same ordering of filter evaluations, which is
an internal-architecture imposition AdCP shouldn't make.

**Wired in.**

- `media-buy/get-products-response.json`: new optional
  `filter_diagnostics` object with the shape above. `additionalProperties:
  true` on each per-filter detail object so filter-specific extensions
  (e.g., per-metric breakdown) can land later without spec churn.
- `docs/media-buy/task-reference/get_products.mdx`: new Response Metadata
  row + dedicated `filter_diagnostics` section with field table and
  example response.

**Backwards compatibility.** Optional and additive. Sellers that don't
populate the field, and buyers that don't consume it, see no change.

**Sell-side adoption.** Zero cost for sellers who don't populate it.
Sellers that already track per-filter exclusion counts internally
surface them with a single new field on their response builder. Sellers
without that instrumentation can adopt incrementally — the field's
absence is conformant.

Closes #3482.
