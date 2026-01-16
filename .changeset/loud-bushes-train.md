---
---

Clarify inline creative handling in media buy operations (Option B):
- `create_media_buy` and `update_media_buy` inline `creatives` array creates NEW creatives only
- Add `CREATIVE_ID_EXISTS` error code for duplicate creative IDs
- Add `CREATIVE_IN_ACTIVE_DELIVERY` error code for sync_creatives
- Document that existing creatives should be managed via `sync_creatives`
