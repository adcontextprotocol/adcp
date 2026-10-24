---
"adcontextprotocol": minor
---

Add `media_buy.supported_delivery_types` to `get_adcp_capabilities` and the `x-adcp-applies-when` schema annotation (#8452).

- `supported_delivery_types` declares whether a seller sells `guaranteed` inventory, `non_guaranteed` inventory, or both, mirroring `supported_pricing_models`. When declared, every returned product carries a listed `delivery_type`. When absent, buyers make no inference.
- `x-adcp-applies-when` names the capability declarations (`delivery_types`, `pricing_models`, `capabilities` paths) that make a property relevant. It never changes validation. Projections, such as a non-guaranteed-only MCP tool surface, use it to drop optional fields from one canonical schema. Initial annotations cover `product.cancellation_policy` (guaranteed), `floor_price` and `price_guidance` on pricing options (non_guaranteed), and the product's conversion-tracking, vendor-metric-optimization, and Trusted Match fields (their capability blocks).
- `scripts/lint-applies-when.cjs` checks every annotation: known keys, enum values, capability paths, and no annotated required properties.
