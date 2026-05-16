---
---

fix(agent-oauth): delegate web OAuth flow to `@adcp/sdk` web helpers

Replaces the bespoke OAuth implementation in `server/src/routes/agent-oauth.ts`
with `@adcp/sdk@^6.13.0`'s `startWebOAuthFlow` / `completeWebOAuthFlow`. The
SDK now owns RFC 9728 PRM discovery, RFC 8707 `resource` indicator forwarding
(on auth, exchange, and refresh), SEP-835 scope priority, dynamic client
registration, and PKCE — so behavior matches the CLI flow that was already
working against agents like `agents.scope3.com/snap`.

User-visible: agents that re-prompted "Connect via OAuth" immediately after a
successful authorization (because we minted tokens with the wrong `aud` per
RFC 8707) now persist a correctly-audienced token after one re-authorize.

Also adds CSRF browser-binding via a session cookie (`adcp_oauth_state`) on
`/api/oauth/agent/start` — verified at `/callback` via the SDK's
`expectedState`. Mismatch surfaces as a `state_mismatch` error code on the
oauth-complete redirect.

`agent_oauth_pending_flows` is now backed by an SDK-shaped
`PendingWebFlowStore` adapter; the obsolete `server/src/db/agent-oauth-flows-db.ts`
module is removed. The PKCE verifier is still encrypted at rest using the
calling org's salt.
