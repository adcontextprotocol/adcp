---
"adcontextprotocol": minor
---

Add Instagram, Facebook, Snapchat and X to `distribution-identifier-type` (adcp#8992), so a creator's social channels can be listed in `collection.distribution[].identifiers` and matched across sellers without falling back to `platform_channel_id`.

Eight values, following the YouTube pattern: a stable ID is the canonical identifier, and a handle is a discovery alias that should resolve to it.
- `instagram_account_id` and `instagram_handle`
- `facebook_page_id` and `facebook_page_handle`
- `snapchat_profile_id` and `snapchat_handle`
- `x_user_id` and `x_handle`

Registries compare handles case-insensitively, as `@` plus the lowercased name, as they already do for `youtube_channel_handle`. The enum description notes the values were added in AdCP 3.3. Adding enum values is additive: every identifier list that accepts these values already accepted `platform_channel_id`, so nothing that validated before stops validating.
