---
"adcontextprotocol": minor
---

Add the `x-adcp-applies-when` schema annotation (#8452). It names the capability declarations (`delivery_types`, `pricing_models`, `capabilities` paths) that make a property relevant, and never changes validation. Projections, such as a guaranteed-only MCP tool surface, use it to drop optional fields from one canonical schema. Initial annotations cover `floor_price` and `price_guidance` on pricing options (non_guaranteed), and the product's `measurement_readiness`, `vendor_metric_optimization`, and `trusted_match` fields (their capability blocks). `product.conversion_tracking` stays unannotated because the product conditionally requires it. `scripts/lint-applies-when.cjs` checks every annotation.
