---
---

feat(admin): add Collections and Placements tabs to adagents.json builder (v3 parity, issue #4420)

Adds two new tabs to the `adagents.json` builder tool (`server/public/adagents-builder.html`) to surface the v3 `collections[]` and `placements[]` fields that were deferred from the initial builder release.

**Collections tab:** CRUD form for `collection_id`, `name`, `kind`, `language`, `status`, `cadence`, `description`, plus a raw JSON escape hatch for remaining optional fields (genre, content_rating, talent[], etc.). Duplicate-ID guard; reserved keys stripped from the advanced textarea to prevent override of validated fields.

**Placements tab:** CRUD form for `placement_id`, `name`, `description`, property scope (checkboxes + property tags), and placement tags. Placement tag registry stored as `{ tag: { name, description } }` map (schema-correct shape for `placement_tags`), preserved verbatim on import/export round-trips. Tags auto-registered on placement save; cascade-deleted from placements on tag removal. Pattern validation on save; tag names normalized to `[a-z0-9_]`.

**Agent modal:** optional `placement_ids` / `placement_tags` overlay fields added to property-scoped agent authorization entries, rendered as checkboxes sourced from the live placements/tags state.

All new `innerHTML` template interpolations pipe values through the existing `escapeHtml()` helper. No schema or backend changes; UI-only.
