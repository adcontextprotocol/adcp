---
---

Add build-time enforcement for vendor_metrics semantic uniqueness key.

Two new lint checks enforce the `(vendor.domain, vendor.brand_id, metric_id)` MUST
constraint documented in `reporting-capabilities.json` and `delivery-metrics.json`
but previously unenforceable by JSON Schema `uniqueItems` (BrandRef optional fields
defeat deep-equal):

1. `scripts/build-schemas.cjs` — scans `examples` arrays in schema JSON files for
   duplicate tuples. Fails the build if violated.
2. `scripts/lint-vendor-metric-uniqueness.cjs` — walks storyboard YAML fixtures and
   checks `sample_request` / `params` fields for duplicate tuples. Wired into
   `build-compliance.cjs`.

Both checks normalize absent `brand_id` to `""` (empty string), distinguishing
`{domain:"x"}` from `{domain:"x",brand_id:"sub"}` as separate brands (house-of-brands
semantics) while still catching accidental duplicates where `brand_id` is dropped on
one copy. The `|` separator is safe — all three key components have patterns that
exclude `|`.

Storyboard check kind `field_unique_by_keys` (issue #3502 item 2) deferred — requires
adcp-client runner implementation. Issue #3501 (vendor-metric storyboard fixture) is
the companion tracker for the conformance storyboard work.

Refs #3502.
