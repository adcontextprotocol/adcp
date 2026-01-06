---
"adcontextprotocol": patch
---

Fix industry alerts not posting to Slack channels

The `hasAlertedPerspective()` check was blocking articles from being posted to real Slack channels if they had already been posted to website-only channels. Removed the redundant check since the SQL query already handles per-channel deduplication correctly.
