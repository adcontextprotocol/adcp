---
---

Server-only changes: Add Addie Slack endpoint and refactor route structure.

- Add separate Slack events endpoint for Addie AI (`/api/addie/slack/events`)
- Extract Slack middleware to `server/src/middleware/slack.ts`
- Extract public Slack routes to `server/src/routes/slack.ts`
- Extract admin Slack routes to `server/src/routes/admin/slack.ts`
- Extract admin Email routes to `server/src/routes/admin/email.ts`
- Create shared unified users cache in `server/src/cache/unified-users.ts`
