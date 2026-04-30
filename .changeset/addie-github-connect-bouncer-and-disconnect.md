---
---

Addie's GitHub Connect link now goes through a session-aware bouncer (`/connect/github`) instead of handing the user a raw WorkOS Pipes URL. Slack-clicked Connect links land in browsers without an active AuthKit session and previously hit WorkOS' generic "Something went wrong" page; the bouncer requires auth (bouncing to `/auth/login` first if needed) and mints a fresh Pipes URL on the click so the token can't go stale between message and click.

Member Hub Connections card gains a Disconnect button backed by a new `DELETE /api/me/connected-accounts/github` route, useful for re-testing the connect flow.
