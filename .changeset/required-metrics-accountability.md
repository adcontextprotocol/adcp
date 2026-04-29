---
"adcontextprotocol": minor
---

Add end-to-end metric accountability through the media buy lifecycle: buyers
can now require specific reporting metrics at discovery time, and delivery
reports surface any gaps in the contract.

**Why.** Without this, a buyer asking for `completed_views` on a CTV CPCV buy
discovers metric availability through `reporting_capabilities.available_metrics`
on each product, then has to manually filter — and at delivery time there is
no field that flags when an advertised metric was not produced. The closest
existing primitive (`required_performance_standards`) is for guarantee
thresholds (e.g., "70% MRC viewability") with vendor selection, not for
capability-level metric discovery.

**Changes.**

- `core/product-filters.json`: new `required_metrics` field on `get_products`
  filters. Sellers MUST silently exclude products whose
  `reporting_capabilities.available_metrics` is not a superset
  (filter-not-fail; do not return an error). The product's declared
  `available_metrics` becomes the binding reporting contract carried into
  the resulting media buy — the same vocabulary computes `missing_metrics`
  on `get_media_buy_delivery`.
- `media-buy/get-media-buy-delivery-response.json`: new `missing_metrics`
  field on each `by_package[]` entry. Lists metrics from the product's
  `available_metrics` that are NOT populated in this report. Empty array (or
  absent) indicates clean delivery; non-empty signals an accountability
  breach. Sellers MUST exclude metrics not yet measurable for the current
  `measurement_window` (e.g., post-IVT counts during the live window) —
  those will appear (or not) when a wider window supersedes this report
  via `supersedes_window`.
- `docs/media-buy/task-reference/get_products.mdx`: documents the new filter,
  filter-not-fail semantics, and the derived-ratio carve-out.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: documents the
  `missing_metrics` field as the accountability signal.
- `static/compliance/source/protocols/media-buy/scenarios/measurement_accountability.yaml`:
  new conformance storyboard exercising the full lifecycle — discovery with
  `required_metrics`, create, simulated delivery, and delivery-report shape
  validation. Storyboard validates schema-level contract; semantic
  enforcement (verifying the seller honestly populates `missing_metrics`)
  is left to a follow-up that extends the test controller with
  metric-omission scenarios.

**No additional field on `create_media_buy`.** The product's declared
`available_metrics` carries forward as the reporting contract — adding a
new field on the buy would duplicate that, and `measurement_terms` /
`performance_standards` already cover guarantee-level commitments at the
package level.

**Backwards compatibility.** Both fields are optional and additive. Existing
sellers that do not populate `missing_metrics` are interpreted as "no breach"
(field absent = clean delivery), so existing reports remain conformant.
Buyers that omit `required_metrics` see the same behavior as today.

**Hint kind follow-up.** A dedicated `metric_accountability_breach` storyboard
hint kind (with Diagnose/Locate/Fix/Verify formatter) is deferred to a
follow-up @adcp/client PR — for now, breach is detectable via standard
schema validation on the delivery response and the storyboard runner's
`field_present` check on populated metrics.

Refs #3460.
