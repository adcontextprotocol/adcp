---
"adcontextprotocol": patch
---

compliance(media-buy): the `canonical_formats`, `billing_finality_delivery`, `measurement_accountability` and `vendor_metric_accountability` scenarios use non-guaranteed product fixtures so `sales-non-guaranteed`-only sellers can run them.

All four seeded guaranteed-only products, so a seller that declares only `specialisms: ["sales-non-guaranteed"]` correctly rejected the create step with a terminal `DELIVERY_MODE_NOT_SUPPORTED` and every dependent phase cascaded `prerequisite_failed` — surfacing as unconditional `products` / `reporting` track failures on hosted grading, although nothing these storyboards grade depends on the delivery type (format declaration shapes, metric-capability filtering, vendor-metric reporting, provisional-vs-final billing rows). Fixtures switch to `non_guaranteed` with floor-priced options, the discovery filters and validations that asked for fixed pricing follow, and the create steps send `bid_price` at the floor — the same fix as the base `media_buy_seller` flow and `available_actions`. No schema or wire change; the packaged `dist/compliance/` cache is generated from this source.
