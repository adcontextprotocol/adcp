---
"adcontextprotocol": minor
---

Add creative_ids filter to sync_creatives for scoped updates and error recovery.

**New Capability:**

The `creative_ids` filter enables targeted creative updates without affecting the entire library. When provided, only the specified creatives are processed, leaving all other creatives untouched.

**Key Use Cases:**

1. **Scoped Updates** - Update 2-3 creatives out of 100+ without including all creatives in the request
2. **Error Recovery** - After bulk sync with validation failures, retry only the failed creatives
3. **Performance** - Publishers can optimize processing when scope is known upfront
4. **Safety** - Explicit targeting reduces risk of unintended changes in large libraries

**Schema Changes:**
- Added optional `creative_ids` array parameter to sync-creatives-request (max 100)
- Works with upsert semantics to scope updates to specific creatives
- Combines naturally with existing validation_mode and dry_run options

**Example - Error Recovery Workflow:**
```json
// After bulk sync where 3 out of 100 failed, retry only those 3:
{
  "creative_ids": ["failed_1", "failed_2", "failed_3"],
  "creatives": [
    {"creative_id": "failed_1", /* corrected data */},
    {"creative_id": "failed_2", /* corrected data */},
    {"creative_id": "failed_3", /* corrected data */}
  ]
}
```

**Documentation Updates:**
- Added creative_ids parameter to Core Parameters table
- Added Example 6: Scoped Update with creative_ids Filter
- Added Example 7: Error Recovery Workflow (complete end-to-end scenario)
- Added Best Practice #6: Scoped Updates guidance
- Updated Error Recovery best practices to recommend creative_ids filter

This complements the replacement semantics pattern established in update_media_buy by enabling subset-based operations without requiring full library enumeration.
