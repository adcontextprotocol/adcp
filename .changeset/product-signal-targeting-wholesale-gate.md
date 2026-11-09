---
"adcontextprotocol": patch
---

Gate `product_signal_targeting` on wholesale support in both `media_buy.buying_modes` and `signals.discovery_modes`. A seller that advertises only brief discovery no longer runs it. Its negative probe now cascade-skips when product discovery fails, instead of sending an unresolved `$context.product_id`.
