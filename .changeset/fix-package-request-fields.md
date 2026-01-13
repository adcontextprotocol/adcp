---
"adcp": patch
---

Add missing fields to package request schemas for consistency with core/package.json.

**Schema Changes:**

- `media-buy/package-request.json`: Added `impressions` and `paused` fields
- `media-buy/update-media-buy-request.json`: Added `impressions` field to package updates

**Details:**

- `impressions`: Impression goal for the package (optional, minimum: 0)
- `paused`: Create package in paused state (optional, default: false)

These fields were defined in `core/package.json` but missing from the request schemas, making it impossible to set impression goals or initial paused state when creating/updating media buys.

**Documentation:**

- Updated `create_media_buy` task reference with new package parameters
- Updated `update_media_buy` task reference with impressions parameter
