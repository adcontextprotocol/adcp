---
---

fix(dashboard-agents): send saved OAuth auth when running "Test your agent" from the dashboard

The storyboard step/run/compare/applicable-storyboards endpoints all called
`complianceDb.resolveOwnerAuth` to pull saved credentials for the agent.
That helper was happy to drop auth on the floor in two cases:

- The user's org context (`organization_memberships`) pointed at an
  `agent_context` whose owning-org `member_profile.agents` list didn't list
  the agent — the JOIN returned empty and `auth` came back `undefined`.
- The OAuth access token was within 5 minutes of expiry — the helper
  returned `undefined` with no attempt to refresh, even when a
  `refresh_token` was sitting next to it.

Either path produced the same symptom: the UI showed "Auth configured via
OAuth" after authorization, but the very next click on **Test your agent**
hit `get_adcp_capabilities` with no `Authorization` header and came back
with `@adcp/client`'s "Missing Authorization header — provide an
OAuthFlowHandler or run an interactive flow" error.

Two fixes in this change:

1. The four storyboard endpoints in `registry-api` now resolve auth through
   a new `resolveUserAgentAuth(userId, agentUrl)` helper that mirrors the
   lookup the `auth-status` endpoint already uses (the same one that drives
   the "Auth configured via OAuth" label). The agent_context consulted for
   auth is now guaranteed to be the one the UI told the user was connected.
2. `complianceDb.resolveOwnerAuth` (still used by the compliance heartbeat
   cron) now returns the full `{ type: 'oauth', tokens, client }` shape
   when a refresh token is available, so the `@adcp/client` SDK can
   silently mint a fresh access token instead of falling off the cliff at
   the 5-minute expiry buffer.

Log levels bumped from `debug` to `info`/`warn` on the auth-resolution
failure paths so future regressions surface in production logs.
