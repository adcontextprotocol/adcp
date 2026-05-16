---
"adcontextprotocol": minor
---

Add optional `vendor: BrandRef` to two vendor-attested rows that lacked structured vendor identity, bringing them into the same identity discipline as `vendor_metric_values`, `performance-standard.vendor`, and `committed_metrics` (vendor-scope entries).

**`core/delivery-metrics.json` `viewability`** (closes #3862). Optional but RECOMMENDED — makes the viewability row self-describing so buyer agents reading delivery in isolation can attribute the numbers to a measurement vendor without joining back to `package.committed_metrics` or `package.performance_standards`. Same shape as `vendor_metric_value.vendor` for symmetry.

**`core/performance-feedback.json`** (closes #3859). SHOULD be populated when `feedback_source` is `third_party_measurement` or `verification_partner` AND a single attesting vendor exists. OMITTED for blended outputs (MMM mixes from Nielsen MMM / Analytic Partners / in-house models, multi-touch attribution that joins across vendors, clean-room outputs from LiveRamp / Habu / AWS Clean Rooms where the clean room is not itself the measurement source) — exactly the high-value third-party signals that don't have a single attesting vendor. Optional for `buyer_attribution` and `platform_analytics` (those sources are implicit from context). Described in the field; not enforced via JSON Schema `if/then`, matching the precedent set by `performance-standard.standard`. Without the BrandRef on single-vendor feedback, the row is unattributed — consumers can't verify authorization, resolve metric definitions via the vendor's `get_adcp_capabilities.measurement.metrics[]`, or route disputes.

Both fields are additive and backwards-compatible. Origin: schema audit run during PR #3843, findings §3.4 and §3.9. Aligns with the [measurement taxonomy](https://docs.adcontextprotocol.org/docs/measurement/taxonomy) doctrinal framing that vendor-attested measurement is anchored on `BrandRef → brand.json agents[type='measurement']` discoverable identities.

Doc updates: `docs/media-buy/task-reference/provide_performance_feedback.mdx` (vendor field row, example payload), `docs/media-buy/media-buys/optimization-reporting.mdx` (viewability field list).
