---
"adcontextprotocol": minor
---

Add support for uploading new creatives via update_media_buy task and clarify replacement semantics for creative assignments.

Previously, buyers could only reference existing library creatives using `creative_ids` when updating a media buy. Now they can also upload new creative assets directly using the `creatives` field in package updates, matching the functionality available in create_media_buy.

**Changes:**
- Added `creatives` field to package update objects in update-media-buy-request.json schema
- Documented replacement semantics for array fields in PATCH updates
- Added examples showing how to add, remove, or replace creative assignments
- Clarified that providing `creative_ids` or `creatives` replaces all existing assignments
- New creatives are automatically added to the creative library when uploaded

**Replacement Semantics:**
- Array fields (like `creative_ids` and `creatives`) use replacement semantics
- To add a creative: include all existing IDs plus the new one
- To remove a creative: include all IDs except the one to remove
- Omitting the field leaves existing assignments unchanged
