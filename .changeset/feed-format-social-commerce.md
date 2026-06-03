---
"adcontextprotocol": minor
---

Add `tiktok_shop`, `pinterest_catalog`, and `openai_product_feed` to the `feed_format` enum, and reconcile `brand.json` to reference the canonical enum.

All three are externally-documented, Google-Merchant-Center-derived product-feed dialects that real sellers (TikTok Shop, Pinterest, OpenAI/ChatGPT commerce) parse natively — so buyers declaring them no longer have to fall back to `custom` + `feed_field_mappings` to re-describe a standardized feed. Each carries material deltas a strict GMC parser would mis-handle (TikTok `sku_id`/`video_link`; Pinterest composite price/shipping + mandatory `google_product_category`; OpenAI `is_eligible_*` flags), which is the bar for a dialect to earn its own value under the #3456 enum-membership criterion.

`feed_format` values are vendor spec names (proper nouns), not semantic categories — a feed format *is* the vendor's published spec, so there is no vendor-neutral name (the deliberate inverse of the semantic `video_placement_types`/`social_placement_surfaces` axes). The enum now carries `enumDescriptions` documenting each format and citing its spec.

`brand.json` previously inlined a drifted feed_format enum (it had `openai_product_feed` but was missing `shopify`/`linkedin_jobs`); it now `$ref`s `/schemas/enums/feed-format.json` (matching `core/catalog.json`), so the two surfaces can no longer diverge.

`feed_format` is a seller-side parsing label only — AdCP ships no per-format mapping table and SDKs do not parse feeds, so first-class membership is a label + SDK enum-widening, not a parser obligation.

Closes #5271. Implements the #3456 enum-membership criterion.
