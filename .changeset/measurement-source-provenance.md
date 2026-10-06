---
"adcontextprotocol": minor
---

Add a shared `enums/measurement-source-type.json` vocabulary (`set_top_box`, `acr`, `panel`, `server_logs`, `client_tracker`, `sdk`) and two optional uses of it. `measurement_terms.billing_measurement.counting_sources[]` declares what the billing count is counted from (sellers whose own system is the named vendor SHOULD declare it; absence means undeclared), and is mirrored in `canonical-measurement-terms.json`. `vendor_metric_values[].measurement_provenance { source_types[], deduplicated? }` carries row-level source provenance for vendor metrics; per DR-0019 adding an optional field to the closed `vendor-metric-value.json` row is minor. Sellers serving a pinned older release should omit both new fields, since strict older validators reject them. `impression_id` joinability and `seller_tracker_events[]` are not part of this change. Records a proposed decision record (number assigned at merge).
