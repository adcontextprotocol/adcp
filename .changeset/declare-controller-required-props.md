---
"adcontextprotocol": patch
---

Declare the `comply_test_controller` request fields that were required but missing from `properties`, so generated SDK types include them (adcp#8345). The `identifier` sub-object of `property_delivery` and `installment_property_delivery` rows now references `core/identifier.json`, and the `installment_ref` sub-object of `installment_property_delivery` and `installment_delivery` rows now references `core/installment-ref.json`, which are the shapes the row descriptions already require. `account` now declares the optional `account_id` that `expire_account_change_cursor` requires.
