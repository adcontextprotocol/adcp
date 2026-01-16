---
"adcontextprotocol": minor
---

Clarify creative handling in media buy operations:

**Breaking:** Replace `creative_ids` with `creative_assignments` in `create_media_buy` and `update_media_buy`
- `creative_assignments` supports optional `weight` and `placement_ids` for granular control
- Simple assignment: `{ "creative_id": "my_creative" }` (weight/placement optional)
- Advanced assignment: `{ "creative_id": "my_creative", "weight": 60, "placement_ids": ["p1"] }`

**Clarifications:**
- `creatives` array creates NEW creatives only (add `CREATIVE_ID_EXISTS` error)
- `delete_missing` in sync_creatives cannot delete creatives in active delivery (`CREATIVE_IN_ACTIVE_DELIVERY` error)
- Document that existing library creatives should be managed via `sync_creatives`
