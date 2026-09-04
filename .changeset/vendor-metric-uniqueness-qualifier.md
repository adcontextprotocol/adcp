---
"adcontextprotocol": patch
---

Fix the build-time vendor-metric uniqueness lint so `vendor_metric_values` rows key on `(vendor.domain, vendor.brand_id, metric_id, qualifier)` — the rule `delivery-metrics.json` already states — instead of collapsing qualifier-distinct rows (7-day vs 30-day attribution windows) into false duplicates. Qualifier canonicalization is key-sorted deep equality, matching the structured-qualifier join rule on `committed-metric.json`. `reporting_capabilities.vendor_metrics` declarations keep the 3-tuple. No wire change.
