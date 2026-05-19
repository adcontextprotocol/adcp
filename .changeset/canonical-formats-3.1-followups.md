---
"adcontextprotocol": minor
---

**Canonical formats 3.1 follow-ups — fixture, vocab, Pinterest disambiguation.**

Closes three of the GA-blocking follow-ups identified in PR #3307 expert review, plus a latent slot-enum bug surfaced by the new fixture:

- **Latent slot `asset_type` enum gap fixed** in `_base.json`. The canonical-formats slot enum was missing `pixel_tracker`, `vast_tracker`, and `daast_tracker` — meaning any product carrying explicit tracker slots (including the `native_in_feed` default slots) failed validation. Added all three to the enum and to the size-mutex if/then "no size semantics" branch. Discovered by the new native_in_feed fixture; would have hit any 3.1 adopter shipping explicit tracker slots.


- **`native_in_feed` reference Product fixture** at `static/examples/products/canonical/taboola_content_recommendation.json`. Realistic Taboola US Content Recommendation product covering all 12 native_in_feed default slots — title, body_text, main_image (1200×627 / 1080×1080), cta with closed enum, advertiser_name, sponsored_label, landing_page_url, display_url, rating, plus impression / viewability / click `pixel_tracker`. CPC pricing, hourly+daily reporting, v1_format_ref points at `native_content`. Brings the canonical fixture suite to 13 (one per canonical, plus generative Veo on video_hosted).

- **Pinterest disambiguation worked example** in `docs/creative/canonical-formats.mdx`. Spells out which Pinterest product routes to which canonical: Promoted Pin → `native_in_feed`, Pinterest Collection → `sponsored_placement` (catalog-keyed), Idea Pin → `image_carousel`, Shopping Pin → `sponsored_placement` (fanout_mode: single_item). The cleave is asset-bundle vs catalog-row composition; same logic applies to Snap Story / Snap Collection, TikTok TopView / TikTok Collection, etc. Closes the routing ambiguity flagged by Pia + Nastassia at GA review.

- **10 new IAB OpenRTB Native 1.2 vocab entries** in `asset-group-vocabulary.json`.
  - Five Data Asset additions: `likes` (type 4), `downloads` (type 5), `saleprice` (type 7), `address` (type 9), `secondary_body_text` aliased to `desc2` (type 10).
  - Five core-native vocab additions surfaced by product-expert review — the `native_in_feed` canonical's default slots referenced these but the vocab didn't have entries, leaving the flagship fixture authoring against non-canonical IDs: `title` (Title Asset type 1; `headline` is the alias for the singular case, distinct from `headlines` pool used by responsive_creative), `main_image` (Image Asset type 3 main, with `image_main`/`hero_image` aliases), `icon` (Image Asset type 1), `advertiser_name` (the IAB `sponsoredBy` field), `sponsored_label` (renderer disclosure string).
  - `phone_number` description annotated with IAB type 8; `body_text` annotated with IAB type 2. `price` description updated to call out the price ↔ saleprice discount-rendering convention.

**Migration doc** updated: 14 reference Product fixtures, dropped the "native_in_feed fixture follows in a subsequent PR" placeholder.

Remaining 3.1 follow-ups tracked separately:
- **SDK codegen (TypeScript + Python)** — multi-week build, the gating dependency for adopter consumption. Schemas shippable today; typed-tagged-union ergonomics arrive with codegen.
- **`native_in_feed` conformance storyboard** — multi-phase YAML to extend `static/compliance/source/protocols/creative/index.yaml` with native sync_creatives + preview coverage.
