---
---

Server-only changes: Refactor Slack endpoints with consistent URL structure.

**BREAKING CHANGE:** Slack endpoint URLs changed:
- AAO bot: `/api/slack/events` → `/api/slack/aaobot/events`
- AAO bot: `/api/slack/commands` → `/api/slack/aaobot/commands`
- Addie: Added `/api/slack/addie/events`

Update Slack app Event Subscription URLs in production.

Also:
- Extract Slack middleware to `server/src/middleware/slack.ts`
- Extract public Slack routes to `server/src/routes/slack.ts`
- Extract admin Slack routes to `server/src/routes/admin/slack.ts`
- Extract admin Email routes to `server/src/routes/admin/email.ts`
- Create shared unified users cache in `server/src/cache/unified-users.ts`
