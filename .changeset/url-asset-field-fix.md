---
"adcontextprotocol": patch
---

Fix URL asset field naming and simplify URL type classification.

**Schema changes:**
- Added `url_type` field to URL asset schema (`/schemas/v1/core/assets/url-asset.json`)
- Simplified `url_type` to two values:
  - `clickthrough` - URL for human interaction (may redirect through ad tech)
  - `tracker` - URL that fires in background (returns pixel/204)

**Documentation updates:**
- Replaced all instances of `url_purpose` with `url_type` across all documentation
- Simplified all tracking URL types (impression_tracker, click_tracker, video_start, video_complete, etc.) to just `tracker`
- Clarified that `url_type` is only used in format requirements, not in creative manifest payloads
- The `asset_id` field already indicates the specific purpose (e.g., `impression_tracker`, `video_start_tracker`, `landing_url`)

**Rationale:**
The distinction between impression_tracker, click_tracker, video_start, etc. was overly prescriptive. The `asset_id` in format definitions already tells you what the URL is semantically for. The `url_type` field distinguishes between URLs intended for human interaction (clickthrough) versus background tracking (tracker). A clickthrough may redirect through ad tech platforms before reaching the final destination, while a tracker fires in the background and returns a pixel or 204 response.
