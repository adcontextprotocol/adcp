---
"adcontextprotocol": minor
---

Add comprehensive creative management to update_media_buy with support for uploading new creatives, updating weights, and managing placement targeting.

Previously, buyers could only reference existing library creatives using simple `creative_ids` when updating a media buy. This limited the ability to adjust creative rotation weights or placement targeting without recreating the entire campaign.

**New Capabilities:**

1. **Upload creatives with weight and placement** - Use `creatives` field to upload and assign new creative assets with optional weight and placement_ids configuration in one step
2. **Update weights and placement targeting** - Use `creative_assignments` field to modify rotation weights (0-100) and placement targeting for existing creatives
3. **Three assignment methods** - Choose the right approach for your use case:
   - `creative_ids`: Simple creative list (add/remove creatives)
   - `creatives`: Upload brand new creative assets with optional weight/placement configuration
   - `creative_assignments`: Granular control over weights and placement targeting for existing creatives

**Schema Changes:**
- Added `creatives` field to package update objects (max 100 creatives)
- Added `creative_assignments` field with weight and placement_ids support
- Extended `creative-asset.json` with optional `weight` and `placement_ids` fields for assignment configuration during upload
- All three fields use replacement semantics for predictable behavior

**Documentation Updates:**
- Documented replacement semantics for array fields in PATCH updates
- Added examples showing how to add, remove, or replace creative assignments
- Added example showing weight and placement targeting updates
- Clarified field selection guidance in usage notes

**Replacement Semantics:**
- Array fields use complete replacement (not merge or append)
- To add a creative: include all existing assignments plus the new one
- To remove a creative: include all assignments except the one to remove
- To update weights/placements: use `creative_assignments` with modified values
- Omitting the field leaves existing assignments unchanged

This brings update_media_buy to feature parity with create_media_buy while adding the ability to fine-tune creative rotation and targeting post-launch.
