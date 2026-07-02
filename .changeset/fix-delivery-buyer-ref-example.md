---
"adcontextprotocol": patch
---

Fix a misleading `get_media_buy_delivery` example that implied buyers can look up delivery by their own reference. `media_buy_ids` are seller-assigned; the top-level `buyer_ref` field was removed in 3.0.0. The example is retitled "Correlating Your Own Reference", uses seller-assigned `mb_...` IDs, and adds a note pointing buyers to reconcile their own reference via `context` echoed on `create_media_buy` / `get_media_buys`.
