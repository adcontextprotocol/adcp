---
"adcontextprotocol": patch
---

compliance(media-buy): the `available_actions` scenario uses a non-guaranteed product fixture so `sales-non-guaranteed`-only sellers can run it.

`available_actions.yaml` seeded a guaranteed-only product, so its `create_buy_from_product` step (and the whole available-actions enforcement flow that follows) failed with a terminal `DELIVERY_MODE_NOT_SUPPORTED` for sellers that declare only `specialisms: ["sales-non-guaranteed"]`. The `allowed_actions` behavior the scenario actually grades is delivery-type-agnostic, so the fixture is switched to `non_guaranteed` (floor-priced) — the same fix applied to the base `media_buy_seller` flow. The packaged `dist/compliance/` cache is generated from this source.
