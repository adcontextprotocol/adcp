---
---

Add `vendor_metric_accountability.yaml` storyboard exercising the declaration → filter → emission lifecycle for vendor-defined metrics added in PR #3492. Extends `comply_test_controller`'s `simulate_delivery` scenario to accept `vendor_metric_values` params and wires them through `ComplyDeliveryAccumulator` into `get_media_buy_delivery` `by_package` entries.
