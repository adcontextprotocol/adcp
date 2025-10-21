---
"adcontextprotocol": minor
---

Add placement targeting for creative assignments. Enables products to define multiple placements (e.g., homepage banner, article sidebar) and buyers to assign different creatives to each placement while purchasing the entire product.

**New schemas:**
- `placement.json` - Placement definition with placement_id, name, description, format_ids
- Added optional `placements` array to Product schema
- Added optional `placement_ids` array to CreativeAssignment schema

**Design:**
- Packages always buy entire products (no package-level placement targeting)
- Placement targeting only via `create_media_buy`/`update_media_buy` creative assignments
- `sync_creatives` does NOT support placement targeting (keeps bulk operations simple)
- Creatives without `placement_ids` run on all placements in the product
