---
---

fix(compliance): send refreshable OAuth creds when Test-your-agent runs from the dashboard

The four storyboard endpoints that back the dashboard's *Test your agent* flow (`applicable-storyboards`, `storyboard/:id/step/:id`, `storyboard/:id/run`, `storyboard/:id/compare`) were pulling saved credentials through `complianceDb.resolveOwnerAuth`, which dropped auth on the floor in two cases:

- The access token was within 5 minutes of `expires_at` — the helper returned `undefined` with no attempt to refresh, even when a `refresh_token` was saved alongside it.
- The chosen `agent_context` was picked by "whichever org lists this agent", not "the org the authenticated user belongs to" — so stale `member_profile.agents` lists could land on an org without credentials.

Either path surfaced as *"Missing Authorization header"* right after a user authorized an OAuth-protected agent.

Fixes:

1. `resolveOwnerAuth` (still called by the compliance heartbeat cron) now returns the full `{ type: 'oauth', tokens, client }` shape when a refresh token is available, so the `@adcp/client` SDK can refresh silently instead of failing at the 5-minute expiry buffer. When no refresh token is saved, it returns the raw access token as a bearer rather than `undefined`, so the agent surfaces a clear 401 instead of the server sending a request with no Authorization header at all.
2. The four storyboard endpoints now resolve auth through a new `resolveUserAgentAuth(orgId, agentUrl)` that uses the authenticated user's own org context — the same org the `auth-status` endpoint (and the UI's "Auth configured via OAuth" label) points at. Ownership resolution and auth lookup share a single query via `resolveAgentOwnerOrg`.

Log levels on the auth-resolution failure paths bumped from `debug` to `warn` so future regressions surface in production logs.
