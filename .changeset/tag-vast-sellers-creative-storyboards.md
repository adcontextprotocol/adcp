---
"adcontextprotocol": patch
---

Stop the 3.1 creative storyboards from failing sellers whose catalog offers only third-party display tags and VAST tags (adcp#8770).

- `dependency_impairment`, `dependency_impairment_cardinality` and `media_buy_seller`'s `creative_sync` build their test creatives from the product format's own declaration with `$build_assets_from_format`, as `creative_fate_after_cancellation` already does. A format whose required assets the test kit cannot supply is graded `not_applicable` with `fixture_unavailable` instead of being sent a fixed image (or, in `media_buy_seller`, a fixed video plus a placeholder image). `media_buy_seller`'s `creative_sync` now runs after `delivery_monitoring`, so that coverage gap cannot drop delivery grading.
- `creative_lifecycle`, `creative/creative_lifecycle_webhooks` and `deterministic_testing`'s creative state machine push a fixed display image only when the seller declares a format that accepts image assets.
- `creative/native_in_feed` and `media_buy_seller/creative_reception` push their fixed native bundle only when the seller declares a format that accepts text and image assets.
