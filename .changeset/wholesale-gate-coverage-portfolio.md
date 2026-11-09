---
"adcontextprotocol": patch
---

Stop `product_coverage_filters` and `portfolio_routing_scope` from failing sellers that declare only brief/refine buying modes. The `get_products` coverage phase of `product_coverage_filters` now requires wholesale in `media_buy.buying_modes`, and its `list_products` phase runs independently. The declared-channel read in `portfolio_routing_scope` now uses brief mode, which every seller supports.
