---
"adcontextprotocol": patch
---

docs(creative): social-DPA video catalog pools + catalog-driven single-item render pattern; add `card_video_max_file_size_kb` parity field

Clarifies that catalog asset pools accept video as a first-class asset group — `core/asset-group-vocabulary.json` already defines `video`, `video_vertical` (9:16), and `video_horizontal` (16:9) pools, and a feed URL mapped via `feed_field` + `asset_group_id` is wrapped as an image *or* video asset depending on the pool. Documented at the "Typed catalog assets" and "Feed field mappings" anchors in `docs/creative/catalogs.mdx`. Docs-only; the capability already ships (#5272).

Documents the catalog-driven single-item render pattern — the platform composes one SKU per impression (Meta DPA single-product render, Snap Collection single-item, TikTok Shopping single-SKU) — using the existing `sponsored_placement` `fanout_mode: single_item`, and links the four adapter-contract families page. Extends the existing asset-bundle-vs-catalog-row prose in `docs/creative/canonical-formats.mdx`. Docs-only; addresses the docs half of #5277. The buyer-selection field and double-brace macro token syntax are deliberately out of scope (separate WG decision).

Adds one optional `card_video_max_file_size_kb` (integer, minimum 1) to `image_carousel.json` as the video twin of the existing `card_image_max_file_size_kb`, so the two per-card file-size caps sit together. Additive optional field on a non-experimental canonical = backward-compatible patch. No codec/container enums or new `card_media_types` vocabulary (#5274).

Closes #5272, #5274. Addresses docs half of #5277.
