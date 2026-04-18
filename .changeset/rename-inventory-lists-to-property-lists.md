---
"adcontextprotocol": major
---

Rename the `inventory-lists` specialism to `property-lists` to match the tool family it actually tests (`create_property_list`, `validate_property_delivery`, etc.). The original name was flagged as onboarding friction in the fresh-builder specialism test (#2287): the specialism claimed to cover "property and collection lists" but the storyboard only exercised property-list tools, and every builder fumbled the `inventory-lists` ↔ `property_list` mapping. A dedicated `collection-lists` specialism can be added later when that storyboard is written.

**Changes.**

- `specialism` enum: `inventory-lists` → `property-lists` (wire ID), with updated `enumDescription` scoped to property lists only.
- Compliance source: `static/compliance/source/specialisms/inventory-lists/` → `property-lists/`. In `index.yaml`: `id: inventory_lists` → `property_lists`, `category: inventory_lists` → `property_lists`, `title: "Inventory lists"` → `"Property lists"`, capability tag and all step `correlation_id`s updated. Summary narrowed to property-list scope (removed "and collection").
- `storyboard-schema.yaml` governance-categories comment updated.
- `compliance-catalog.mdx`: governance table, naming conventions example, mapping table, and tool-family prose bullet now use `property-lists` / `property_lists`.
- `glossary.mdx`: added **Specialism**, **Storyboard**, and **Storyboard Category** entries documenting the kebab↔snake split between wire IDs, storyboard categories, and prose titles.

**Not renamed.** The media-buy scenarios `media_buy_seller/inventory_list_targeting` and `media_buy_seller/inventory_list_no_match` keep their IDs — they genuinely exercise both `PropertyListReference` and `CollectionListReference` targeting and are correctly "inventory list" umbrella scenarios.

**Wire enum change (RC-window), no alias.** The `specialism` enum is only shipping in 3.0-rc.3 and has no published SDK or registered agent declaring `inventory-lists` today (verified across server, skills, docs, dist schemas, AAO runner). An alias would be dead weight. Contrast with the `audience-sync-domain-and-naming-docs` rename, which did emit transitional aliases because `@adcp/client@5.x` reads the old key — no comparable consumer exists here.

Closes #2287 (the last open sub-issue of the fresh-builder epic #2288).
