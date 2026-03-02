---
---

Fix three gaps in Slack auto-link reliability: run syncSlackUsers() before the daily job so users who missed team_join events are visible; skip tryAutoMapByEmail for bots to prevent stolen mappings; invalidate admin status cache immediately after linking so newly linked admins are recognized by Addie without waiting 30 minutes.
