---
"adcontextprotocol": patch
---

compliance: make every buyer-storyboard fixture product valid as both a legacy and a canonical Product. The fixture publisher serves the same products from `get_products` and `list_products`, but the `buyer_discovery`, `buyer_activation`, `buyer_negotiation`, and `buyer_recovery` fixtures failed both schemas: missing `name`, `description`, `publisher_properties`, `reporting_capabilities`, and formats, a CTV price under a non-schema `rate` key instead of `fixed_price`, and a per-product `audience_activation` the canonical Product does not define. `buyer_activation` now declares the `format_options` its creative step grades against. The fixture-publisher contract states the rule, and a new test enforces it.
