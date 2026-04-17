---
---

Training agent fixes for update_media_buy and get_brand_identity:

- **#2247**: update_media_buy now returns errors in the response body (spec-compliant UpdateMediaBuyError variant) so storyboard validators can read `errors[].code`. Re-canceling an already-canceled buy returns `NOT_CANCELLABLE` (previously `INVALID_STATE`); pause/resume on a terminal buy still returns `INVALID_STATE`.
- **#2240**: update_media_buy now honors `packages[].creative_assignments`, replacing the package's assignments and auto-transitioning out of `pending_creatives` once all packages have creatives.
- **#2162**: get_brand_identity returns a brand.json-shaped response (`$schema`, `house` object, `brands[]` with full identity fields), while still echoing `brand_id`/`house`/`names`/identity fields at the top level for get-brand-identity-response.json schema compliance.
