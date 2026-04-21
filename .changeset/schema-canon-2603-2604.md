---
"adcontextprotocol": patch
---

spec(schemas): canonicalize governance conditions shape and catalog item_count presence (#2603, #2604)

`check-governance-response.json` now enforces the spec-described presence rules for `conditions`, `findings`, and `expires_at` via `if`/`then`:

- `status: conditions` → `conditions` required with `minItems: 1` (a conditions decision with no conditions is non-actionable for the buyer)
- `status: denied` → `findings` required with `minItems: 1` (a denial with no finding gives the buyer nothing to act on)
- `status: approved` or `status: conditions` → `expires_at` required (descriptions already said so; the schema now enforces it)

`sync-catalogs-response.json` now requires `item_count` when `action` is `created`, `updated`, or `unchanged`. The field was already defined on the schema; the tightening aligns it with storyboard assertions (e.g., `sales_catalog_driven` expects `catalogs[0].item_count`). `action: failed` and `action: deleted` still omit `item_count` as they do today.

Audit against #2604's other instances:

- `create-media-buy-response.json` `property_list` / `collection_list` echo: already in the schema via `packages[].targeting_overlay` (→ `property-list-ref` / `collection-list-ref`, both of which require `list_id`). Storyboard `inventory_list_targeting.yaml` reads via `media_buys[0].packages[0].targeting_overlay.property_list.list_id`. No change.
- `list-creatives-response.json` `pricing_options`: already required as an array with `minItems: 1` referencing `vendor-pricing-option.json` (which requires `pricing_option_id`). No change.
- `report-usage-request.json` `vendor_cost`: already in the items' required list. No change.

Conformant agents that follow the prose descriptions already emit these fields; the tightenings move enforcement from "storyboards catch it" to "schemas catch it" so bad responses fail at `response_schema` validation instead of slipping through and failing a downstream `field_present` check with a less obvious diagnostic.
