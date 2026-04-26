---
"adcontextprotocol": patch
---

feat(creative): v2 Phase 1 — asset_group_id vocabulary registry, `scenes` schema, `delivery_type` on html/javascript assets, video.mdx asset_type fix

First PR implementing the v2 creative formats RFC (#3305). Backwards-compatible additions only — no v1 producers are affected.

**New schemas:**
- `static/schemas/source/core/asset-group-vocabulary.json` — canonical registry of `asset_group_id` values (the seven existing catalog vocab entries plus 12 audit-driven additions: `video_vertical`, `video_horizontal`, `audio`, `companion_image`, `companion_banner`, `brand_name`, `body_text`, `cards`, `landing_page_url`, `privacy_policy_url`, `youtube_video_id`, `pin_id`). Includes the `landing_page_url` aliases canonicalizing six different field names today (`click_url`, `link`, `final_url`, `link_url`, `click_through_url`, `landing_url`). Non-canonical IDs remain valid for platform-specific extensions; validators MAY soft-warn on non-canonical usage.
- `static/schemas/source/creative/scenes.json` — typed scene-by-scene structure used as input to `build_creative` for generative video platforms. Each scene has `order`, `duration_ms`, `description`, optional `vo` and `caption`. Renamed from "storyboard" to avoid collision with the testing-harness storyboard concept.

**Schema additions (backwards-compatible):**
- `html-asset.json` and `javascript-asset.json` — added optional `delivery_type` discriminator with `oneOf` for inline (existing) or url (new). v1 producers that don't emit `delivery_type` continue to validate via the inline branch (`content` required). New url branch lets HTML5 zip URLs and 3P display tag URLs round-trip cleanly without iframe-wrapping at runtime. Mirrors the VAST/DAAST naming convention; uses oneOf without the formal `discriminator` keyword to preserve v1 producer compatibility (the registry's `nested_discriminator_pattern` doc scopes the strict pattern to "future asset types with internal variants").

**Doc fix:**
- `docs/creative/channels/video.mdx:421-450,762-775` — corrected three format-definition examples that used `asset_type: "url"` + `asset_role: "vast_url"` / `"vpaid_url"`, contradicting the schema-correct `asset_type: "vast"` used elsewhere in the same file. Updated VPAID examples to use `asset_type: "vast"` with `vpaid_enabled: true` in requirements.

**Why patch:** schema additions and a doc bugfix; no breaking changes to the published spec.

Tracks #3305 (v2 RFC). Subsequent phases: canonical format catalog + `ProductFormatDeclaration` schema (Phase 2), `validate_input` and `preview_creative` updates (Phase 3), SDK codegen (Phase 4).
