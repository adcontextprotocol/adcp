---
"adcontextprotocol": minor
---

**Canonical formats (AdCP 3.1).** v2 introduces a structured creative-format vocabulary that buyers and sellers can validate against without per-seller integration code. 12 canonical `format_kind` values (image, html5, display_tag, image_carousel, video_hosted, video_vast, audio_hosted, audio_daast, sponsored_placement, responsive_creative, agent_placement, custom) with a two-axis model: `format_kind` names the creative TYPE; `asset_source` names the production model (buyer_uploaded / publisher_host_recorded / seller_pre_rendered_from_brief / seller_human_designed / agent_synthesized). Products carry `format_options[]` declarations narrowing a canonical with `params`, `slots`, `applies_to_channels`, optional `capability_id` for multi-format routing, and optional `experimental` flag. The full reference is at `docs/creative/canonical-formats.mdx`.

**Wire-shape details adopters care about:**

- `v1_format_ref` is ALWAYS an array of `{agent_url, id}` entries — single-ref is `[{...}]`. Multi-size declarations carry one ref per size in `params.sizes[]`. The `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE` error code surfaces when ref count < sizes[] count.
- v1 catalog's `canonical:` annotation is ALWAYS an object — minimal `{ "kind": "image" }`, rich `{ "kind", "asset_source", "slots_override" }`. The object form is what lets the 8 generative catalog entries (`display_*_generative`) project losslessly to v2: buyer ships a text prompt, not image bytes.
- Display canonicals (`image`, `html5`, `display_tag`) support three size modes (mutex-enforced at schema layer): fixed `width+height`, multi-size `sizes: [{w,h}]` (mirrors OpenRTB `banner.format[]`), responsive `min_width/max_width/min_height/max_height`. The same product can carry N format_options across the three modes.
- `ProductFormatDeclaration.canonical_formats_only: true` is the v2-only marker (mutex with `v1_format_ref`).
- `format_kind: "custom"` requires `format_shape` (vocabulary entry) + `format_schema` (URI+digest) and either `canonical_formats_only: true` OR `v1_format_ref`.

**Publisher catalog (`adagents.json formats[]`).** Publishers declare their format support once via top-level `formats[]` (with optional `applies_to_property_ids` / `applies_to_property_tags` scoping). Placements reference declarations by `capability_id`. For platforms that haven't adopted AdCP (Meta, TikTok, etc.), AAO publishes community-maintained adagents.json at `creative.adcontextprotocol.org/translated/<platform>/adagents.json`; `superseded_by` field signals platform-adoption cutover. New media-buy filters `list_creative_formats(publisher_domain, property_id)` answer "what formats does this publisher accept?" with a normative resolution chain (publisher hosted → AAO mirror → agent-derived from products) and a response `source` field labeling which tier produced the list.

**Where each piece of metadata lives (the "no new canonical" pattern).** Before reaching for a new canonical, the spec checks: production model → `asset_source`; slot shape → `slots_override`; channel → `applies_to_channels`; tracking / measurement → `sync_event_sources` / `event_log`. New canonical only when the CREATIVE ASSET is structurally different. Applied: generative, broadcast TV, DOOH, native all stay on existing canonicals via sibling refinement. Conversion pixels (Meta Pixel, GA4) explicitly belong on event_log, NOT on `platform_extensions` of a creative format.

**Coverage at GA.** 50/50 ad formats in the AAO catalog annotated with the projection-ref object form. 7 UI scaffolding entries (`product_card_*`, `format_card_*`, `proposal_card_*`, `native_product_card`) split into `ui-element-formats.json` — they're agent-interface widgets, not ad formats; `list_creative_formats` returns them so consumers can resolve by `format_id`, but they never project to ad canonicals.

**Error codes added** (all surfaced via response `errors[]` augmentation; non-fatal advisories): `FORMAT_PROJECTION_FAILED`, `FORMAT_DECLARATION_DIVERGENT`, `FORMAT_DECLARATION_V1_AMBIGUOUS`, `FORMAT_CAPABILITY_UNRESOLVED`, `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE`.

**Native tracker asset type (#4706)**: new `native_tracker` asset type at `static/schemas/source/core/assets/native-tracker-asset.json` — native parity to `vast_tracker` (#3051). Discriminated union with `event` (impression, viewable_mrc_50, viewable_mrc_100, viewable_video_50, click, custom), `method` (img, js), `url` (uri-template with universal-macros support), and `custom_event_name` (required when event is `custom`). Maps to IAB OpenRTB Native 1.2 `imptrackers[]` / `jstracker` / `eventtrackers[]` / `link.clicktrackers[]`. Scope is RENDERER-FIRED trackers — conversion pixels (Meta Pixel, GA4, server-side postbacks) stay on `sync_event_sources` / `event_log` per the format-vs-event_log boundary documented in canonical-formats.mdx. `native_standard` and `native_content` catalog entries upgraded to use `native_tracker` for impression and click trackers (was bare `url` asset, losing event/method semantics). New vocabulary entries: `impression_tracker`, `click_tracker`, `viewability_tracker` in asset-group-vocabulary.

**Other adopter-facing additions:**

- `ProductFormatDeclaration.seller_preference: "preferred" | "accepted" | "discouraged"` — soft routing hint on multi-format products.
- `placement-definition.json format_options[]` (capability_id reference OR inline) with same-file resolution scope.
- Convention lint at `tests/canonical-format-conventions.test.cjs` enforces: object-form `canonical:`, array-form `v1_format_ref[]`, size-mode mutex, AAO-mirror URL convention, slot/param consistency.

**Resolves** #4148 (canonical-formats vocabulary), #4620 (publisher-scoped catalogs), #4652 (.adcp placeholder cleanup), #4689 (catalog generative deannotation). Coordinated with adcp-client #1815 (SDK v1↔v2 projection) and adcp-go (catalog consumer).
