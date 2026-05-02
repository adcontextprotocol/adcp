---
"adcontextprotocol": minor
---

Add optional `vendor: BrandRef` to two vendor-attested rows that lacked structured vendor identity, bringing them into the same identity discipline as `vendor_metric_values`, `performance-standard.vendor`, and `committed_metrics` (vendor-scope entries).

**`core/delivery-metrics.json` `viewability`** (closes #3862). Optional but RECOMMENDED — makes the viewability row self-describing so buyer agents reading delivery in isolation can attribute the numbers to a measurement vendor without joining back to `package.committed_metrics` or `package.performance_standards`. Same shape as `vendor_metric_value.vendor` for symmetry.

**`core/performance-feedback.json`** (closes #3859). Required when `feedback_source` is `third_party_measurement` or `verification_partner` (described in the field; not enforced via JSON Schema `if/then` for v1 simplicity, matching the precedent set by `performance-standard.standard`'s "required when metric is viewability" pattern). Optional for `buyer_attribution` and `platform_analytics` (those sources are implicit from context). Without the BrandRef, third-party feedback rows are unattributed — consumers can't verify authorization, resolve metric definitions via the vendor's `get_adcp_capabilities.measurement.metrics[]`, or route disputes.

Both fields are additive and backwards-compatible. Origin: schema audit run during PR #3843, findings §3.4 and §3.9. Aligns with the [measurement taxonomy](https://docs.adcontextprotocol.org/docs/measurement/taxonomy) doctrinal framing that vendor-attested measurement is anchored on `BrandRef → brand.json agents[type='measurement']` discoverable identities.

Doc updates: `docs/media-buy/task-reference/provide_performance_feedback.mdx` (vendor field row, example payload), `docs/media-buy/media-buys/optimization-reporting.mdx` (viewability field list).
