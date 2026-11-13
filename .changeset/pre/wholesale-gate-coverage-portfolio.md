---
"adcontextprotocol": patch
---

Stop `product_coverage_filters` and `portfolio_routing_scope` from failing sellers that declare only brief/refine buying modes. The `get_products` coverage phase of `product_coverage_filters` now requires wholesale in `media_buy.buying_modes`, and its `list_products` phase runs independently. In `portfolio_routing_scope`, the wholesale read that checks returned channels against the declared allowlist moves to its own phase, which runs only for sellers that declare wholesale, so brief-only sellers are no longer sent a wholesale request they cannot serve.
