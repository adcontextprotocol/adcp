---
"adcontextprotocol": minor
---

Add a shared MediaBuy-level `frequency_cap` (one counter across every package) with `media_buy.aggregate_frequency_capping` seller capability, `Product.media_buy_support` participation, discovery via `required_media_buy_support` and `media_buy_frequency_cap`, the `update_media_buy_frequency_cap` action, and proposal-refinement removal. Scope is determined by field location; package caps are unchanged. `ACTION_NOT_ALLOWED.attempted_action` now references the structured action-id schema so it can name `update_media_buy_frequency_cap`; 3.1 SDKs that validate that field against the flat `media-buy-valid-action` enum should update.
