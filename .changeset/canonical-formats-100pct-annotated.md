---
"adcontextprotocol": minor
---

canonical-formats: annotate the remaining 9 ad formats (50/50 ad formats now annotated) and split UI scaffolding into its own file. Applies the projection-ref refinement pattern instead of creating new canonicals.

**Annotated (9 entries, all `canonical: { kind: ... }` form):**

- `broadcast_spot_15s`, `broadcast_spot_30s`, `broadcast_spot_60s` → `video_hosted`. Broadcast vs streaming is a delivery/channel concern, not a format-shape concern — sellers narrow via `applies_to_channels: ["tv"]` on the v2 product (channels enum already has `tv`).
- `dooh_billboard_1920x1080`, `dooh_billboard_landscape`, `dooh_billboard_portrait`, `dooh_transit_screen` → `image`. Same pattern — DOOH's no-click/timeline-based-impressions/MAID-targeting differences are event_log and delivery concerns, not creative-shape concerns. Asset is a still image; sellers narrow via `applies_to_channels: ["dooh"]`.
- `native_standard` → `image` with `asset_source: buyer_uploaded` + `slots_override` covering image_main + headline + body_text + cta + brand_name.
- `native_content` → `image` with `asset_source: buyer_uploaded` + `slots_override` covering image_main + headline + body_text + landing_page_url + disclosure.

**UI scaffolding split out:**

- 7 card entries (`product_card_{standard,detailed}`, `proposal_card_{standard,detailed}`, `format_card_{standard,detailed}`, `native_product_card`) moved from `reference-formats.json` to a new sibling `ui-element-formats.json`. These are UI scaffolding for product/proposal display surfaces in the training agent and previewer — NOT ad formats. They never project to ad canonicals; conflating them in the same file forces every projection rule to special-case them.
- `list_creative_formats` (served from `reference-formats.json`) stops returning these. Internal consumers (training-agent product-factory, creative-agent preview-renderer) reference them by string ID, which still works — they don't load the schema.

**Pattern reaffirmed.** No new canonicals (no `image_generative`, no `video_broadcast`, no `dooh`). Differences in delivery/channel/event-model live on existing axes (`applies_to_channels`, `asset_source`, `slots_override`, event_log surfaces). Sibling refinement before canonical multiplication.

**Coverage:** 50/50 ad formats in the catalog are now annotated. Catalog discovery via `list_creative_formats` returns ad formats only; UI elements are internal-use.
