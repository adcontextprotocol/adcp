---
"adcontextprotocol": minor
---

`get_media_buy_delivery`: `media_buy_deliveries[].by_package` now requires at least one row (`minItems: 1`). Every media buy has at least one package, so a delivery row always carries at least one `by_package` entry, and sellers SHOULD return one per package. An empty `by_package` array was schema-valid but left buyers unable to price, cap or reconcile delivery per package, because packages can carry different rates, pricing models and budgets.
