---
"adcontextprotocol": minor
---

feat(creative): v2 Phase 1 — asset_group_id vocabulary registry, `scenes` schema, `zip` asset type, video/audio mdx asset_type fixes

First PR implementing the v2 creative formats RFC (#3305). Backwards-compatible additions only — no v1 producers are affected. Minor bump because this introduces new schemas (`asset-group-vocabulary.json`, `scenes.json`, `zip-asset.json`), which are additive features rather than bug fixes.

**New schemas:**

- `static/schemas/source/core/asset-group-vocabulary.json` — canonical registry of `asset_group_id` values (the seven existing catalog vocab entries plus 12 audit-driven additions: `video_vertical`, `video_horizontal`, `audio`, `companion_image`, `companion_banner`, `brand_name`, `body_text`, `cards`, `landing_page_url`, `privacy_policy_url`, `youtube_video_id`, `pin_id`). Includes the `landing_page_url` aliases canonicalizing six different field names today (`click_url`, `link`, `final_url`, `link_url`, `click_through_url`, `landing_url`). Non-canonical IDs remain valid for platform-specific extensions; validators MAY soft-warn on non-canonical usage.

- `static/schemas/source/creative/scenes.json` — typed scene-by-scene structure used as input to `build_creative` for generative video platforms. Each scene has `order`, `duration_ms`, `description`, optional `vo` and `caption`. Renamed from "storyboard" to avoid collision with the testing-harness storyboard concept; description disambiguates from `reference-asset.json` `purpose: "storyboard"` (which describes a reference asset, not a structured plan).

- `static/schemas/source/core/assets/zip-asset.json` — new asset type for bundled creatives delivered as zip archives (HTML5 banners with index.html + CSS + JS + images, MRAID-compatible interactive ads). Carries `url`, optional `max_file_size_kb`, `entry_point`, `allowed_inner_extensions`, `backup_image_url`, and SHA-256 `digest` for integrity. Distinct from inline HTML (`html` asset) and from third-party tag URLs (`url` asset with appropriate `url_type`).

**Registry updates:**

- `static/schemas/source/creative/asset-types/index.json` — added `zip` entry pointing at the new schema
- `static/schemas/source/core/format.json` — added `IndividualZipAsset` and `GroupZipAsset` branches to the format declaration oneOf
- `static/schemas/source/core/offering-asset-group.json`, `creative-manifest.json`, `creative-asset.json`, `creative/list-creatives-response.json` — added `zip-asset.json` to manifest/asset-group oneOf branches so manifests can carry zip assets

**Doc fixes:**

- `docs/creative/channels/video.mdx` — corrected three format-definition examples that used `asset_type: "url"` + `asset_role: "vast_url"` / `"vpaid_url"`, contradicting the schema-correct `asset_type: "vast"` used elsewhere in the same file. Updated VPAID examples to use `asset_type: "vast"` with `vpaid_enabled: true` in requirements.
- `docs/creative/channels/audio.mdx:200` — same bug pattern: `asset_type: "url"` for what should be a VAST audio tag. Corrected to `asset_type: "vast"` with `delivery_type: "url"`; renamed slot key from `vast_url` to `vast_tag` for clarity.

**Why minor (not patch):** new schemas and a new asset type are additive features — patch is reserved for bug fixes only. **Why not major:** no breaking changes; v1 producers and consumers continue to work unchanged. The new `zip` asset type is purely additive — receivers that don't recognize it ignore it via standard discriminator-mismatch handling.

Tracks #3305 (v2 RFC). Phase 1 lays foundational primitives; subsequent phases build the canonical format catalog, `ProductFormatDeclaration` schema, and tools on top of these primitives.
