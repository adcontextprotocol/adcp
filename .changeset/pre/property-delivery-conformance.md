---
"adcontextprotocol": minor
---

Add capability-gated conformance for property-grain delivery reporting. `get_adcp_capabilities` gains seller-wide rollups `media_buy.features.supports_property_breakdown` and `media_buy.features.supports_installment_property_breakdown`, named like the per-product flags in `reporting_capabilities`. Declaring a rollup commits the seller to return `by_property` / `by_installment_property` and their truncation, suppression, and sort companions on every product that declares the matching per-product flag, which remains authoritative for each product.

`comply_test_controller` `simulate_delivery` accepts `property_delivery[]` and `installment_property_delivery[]`, each row a complete `core/property-delivery-metrics.json` or `core/installment-property-delivery-metrics.json` row. Sellers MUST build the breakdown from exactly the injected rows and MUST NOT synthesize property delivery from catalog eligibility. Two new scenarios, `media_buy_seller/property_delivery_reporting` and `media_buy_seller/installment_property_delivery_reporting`, are gated on the rollups and grade `not_applicable` for sellers that do not declare them. Injected rows carry no suppression control, so the scenarios assert `*_suppressed: false`.
