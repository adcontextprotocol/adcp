---
"adcontextprotocol": minor
---

Add support for uploading new creatives via update_media_buy task.

Previously, buyers could only reference existing library creatives using `creative_ids` when updating a media buy. Now they can also upload new creative assets directly using the `creatives` field in package updates, matching the functionality available in create_media_buy.

**Changes:**
- Added `creatives` field to package update objects in update-media-buy-request.json schema
- Updated documentation with example showing creative upload during updates
- New creatives are automatically added to the creative library when uploaded
