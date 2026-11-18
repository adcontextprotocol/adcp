---
"adcontextprotocol": patch
---

Gate `product_signal_targeting` and `cross_path_targeting_provenance` on wholesale support in both `media_buy.buying_modes` and `signals.discovery_modes`. A seller that advertises only brief discovery no longer runs them. Their negative probes now cascade-skip when product discovery fails, instead of sending an unresolved `$context.product_id`.
