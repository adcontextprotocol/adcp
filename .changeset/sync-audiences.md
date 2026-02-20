---
"adcontextprotocol": minor
---

Add `sync_audiences` task for CRM-based audience management.

Buyers wrapping closed platforms (LinkedIn, Meta, TikTok, Google Ads) need to upload hashed CRM data before creating campaigns that target or suppress matched audiences. This adds a dedicated task for that workflow, parallel to `sync_event_sources`.

Schema:
- New task: `sync_audiences` with request and response schemas
- New core schema: `audience-member.json` — hashed identifiers for CRM list members (email, phone, MAIDs)
- `targeting.json`: add `audience_include` and `audience_exclude` arrays for referencing audiences in `create_media_buy` targeting overlays

Documentation:
- New task reference: `docs/media-buy/task-reference/sync_audiences.mdx`
- Updated `docs/media-buy/advanced-topics/targeting.mdx` with `audience_include`/`audience_exclude` overlay documentation
