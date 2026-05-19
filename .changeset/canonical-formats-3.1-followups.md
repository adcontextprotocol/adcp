---
"adcontextprotocol": patch
---

**Canonical formats 3.1 follow-ups — fixture, vocab, Pinterest disambiguation.**

Closes three of the GA-blocking follow-ups identified in PR #3307 expert review, plus a latent slot-enum bug surfaced by the new fixture:

- **Latent slot `asset_type` enum gap fixed** in `_base.json`. The canonical-formats slot enum was missing `pixel_tracker`, `vast_tracker`, and `daast_tracker` — meaning any product carrying explicit tracker slots (including the `native_in_feed` default slots) failed validation. Added all three to the enum and to the size-mutex if/then "no size semantics" branch. Discovered by the new native_in_feed fixture; would have hit any 3.1 adopter shipping explicit tracker slots.


- **`native_in_feed` reference Product fixture** at `static/examples/products/canonical/taboola_content_recommendation.json`. Realistic Taboola US Content Recommendation product covering all 12 native_in_feed default slots — title, body_text, main_image (1200×627 / 1080×1080), cta with closed enum, advertiser_name, sponsored_label, landing_page_url, display_url, rating, plus impression / viewability / click `pixel_tracker`. CPC pricing, hourly+daily reporting, v1_format_ref points at `native_content`. Brings the canonical fixture suite to 13 (one per canonical, plus generative Veo on video_hosted).

- **Pinterest disambiguation worked example** in `docs/creative/canonical-formats.mdx`. Spells out which Pinterest product routes to which canonical: Promoted Pin → `native_in_feed`, Pinterest Collection → `sponsored_placement` (catalog-keyed), Idea Pin → `image_carousel`, Shopping Pin → `sponsored_placement` (fanout_mode: single_item). The cleave is asset-bundle vs catalog-row composition; same logic applies to Snap Story / Snap Collection, TikTok TopView / TikTok Collection, etc. Closes the routing ambiguity flagged by Pia + Nastassia at GA review.

- **5 new IAB OpenRTB Native 1.2 Data Asset vocab entries** in `asset-group-vocabulary.json`: `likes` (type 4), `downloads` (type 5), `saleprice` (type 7), `address` (type 9), `secondary_body_text` aliased to `desc2` (type 10). Promoting these from `slots_override` extensions to canonical vocab tightens validation for app-install and e-commerce native units. `phone_number` description also annotated with its IAB type 8 mapping.

**Migration doc** updated: fixture count 12 → 13, dropped the "native_in_feed fixture follows in a subsequent PR" placeholder.

Remaining 3.1 follow-ups tracked separately:
- **SDK codegen (TypeScript + Python)** — multi-week build, the gating dependency for adopter consumption. Schemas shippable today; typed-tagged-union ergonomics arrive with codegen.
- **`native_in_feed` conformance storyboard** — multi-phase YAML to extend `static/compliance/source/protocols/creative/index.yaml` with native sync_creatives + preview coverage.
- **Adopter cohort communication** — Slack-back to the round-1 pilot cohort (Pia, Nastassia, others) confirming nobody has a catalog-less sponsored_placement mid-pilot before GA.
