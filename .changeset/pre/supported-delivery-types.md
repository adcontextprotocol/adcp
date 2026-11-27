---
"adcontextprotocol": minor
---

Add `media_buy.supported_delivery_types` to `get_adcp_capabilities`. A seller declares whether it sells `guaranteed` inventory, `non_guaranteed` inventory, or both, mirroring `supported_pricing_models`, so buyers can filter sellers before calling `get_products`. Like every capability declaration, it is a commitment: a declaring seller returns only products with a listed `delivery_type`. When absent, buyers treat the seller's delivery types as unknown.
