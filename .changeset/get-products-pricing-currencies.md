---
"adcontextprotocol": minor
---

Add `filters.pricing_currencies` to `get_products` so buyers can restrict discovery to media products priced in currencies they can transact in.

The filter matches products with at least one product-level `pricing_options` entry in a requested ISO 4217 currency, requires mandatory product-scoped signal charges to be satisfiable in those currencies or have no incremental price, and requires sellers to prune returned product-level `pricing_options` to matching currencies.
