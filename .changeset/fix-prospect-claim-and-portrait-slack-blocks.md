---
---

Fix two production errors surfaced in `#admin-errors`:

- Prospect-claim Slack action looked up `users.slack_user_id`, but that column doesn't exist — Slack↔WorkOS linkage lives in `slack_user_mappings`. The lookup now joins through that table on `mapping_status = 'mapped'`.
- Member-announcement Slack cards passed `member_portraits.image_url` (a same-origin relative path like `/api/portraits/{id}.png`) into a Slack `image` block, which Slack can't fetch. Portrait URLs are now resolved to absolute `APP_URL`-prefixed URLs and re-validated through `isSafeVisualUrl` before reaching Slack; on reject the visual falls back to the AAO mark.
