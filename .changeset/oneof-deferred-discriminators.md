---
"adcontextprotocol": patch
---

Add `discriminator: { propertyName }` to two more `oneOf` unions previously deferred from #3928:

- `core/pricing-option.json` `#/oneOf` (`pricing_model`) — Ajv resolves the cross-file `$ref` to each `pricing-options/*-option.json` correctly when all schemas are pre-loaded; the deferral was based on a faulty isolated-compile test.
- `core/format.json` `#/properties/assets/items/oneOf/14/properties/assets/items/oneOf` (`asset_type`) — required `asset_type` on each of the 12 inner variants directly so Ajv's discriminator support can find it without traversing `allOf`.

The 15-variant outer oneOf at `#/properties/assets/items` is still deferred — it mixes `item_type: "individual"` (14 variants with `asset_type`) and `item_type: "repeatable_group"` (no `asset_type`), so a single discriminator key doesn't cover it without a structural restructure. Tracked separately. Same for the boolean-discriminator unions (`get-adcp-capabilities-response.json` `supported`, `update-content-standards-response.json` `success`) which need an enum migration. Tracking: adcp#3917.
