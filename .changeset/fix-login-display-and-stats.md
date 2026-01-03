---
"adcontextprotocol": patch
---

Fix navigation login state and improve user activity stats

- Fix navigation showing "Log in/Sign up" when user is authenticated by adding session refresh to `getUserFromRequest()`
- Hide "0 Messages" and "0 Active Days" stats when there's no activity
- Include web chat messages in user stats alongside Slack activity by querying `addie_threads` table
