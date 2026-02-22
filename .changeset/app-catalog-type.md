---
"adcontextprotocol": minor
---

Add `app` catalog type for mobile app install and re-engagement advertising.

Introduces `AppItem` schema with fields for `bundle_id`, `apple_id`, `platform` (ios/android), store metadata, and deep links. Maps to Google App Campaigns, Apple Search Ads, Meta App Ads, TikTok App Campaigns, and Snapchat App Install Ads.

Also adds `app_id` to `content-id-type` for conversion event matching and `APP_ITEM_ID` to universal macros for tracking URL substitution.
