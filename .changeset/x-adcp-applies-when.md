---
"adcontextprotocol": minor
---

Add the `x-adcp-applies-when` schema annotation (#8452). It names the capability declarations (`delivery_types`, `pricing_models`, `capabilities` paths) that make a property relevant, and never changes validation. Projections, such as a non-guaranteed-only MCP tool surface, use it to drop optional fields from one canonical schema. Initial annotations cover `product.cancellation_policy` (guaranteed), `floor_price` and `price_guidance` on pricing options (non_guaranteed), and the product's conversion-tracking, vendor-metric-optimization, and Trusted Match fields (their capability blocks). `scripts/lint-applies-when.cjs` checks every annotation.
