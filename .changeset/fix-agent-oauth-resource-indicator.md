---
---

fix(dashboard-agents): unblock Test-your-agent OAuth loop and stop lying about scheduled checks

Two fixes for the `/dashboard/agents` page:

1. **OAuth `resource` indicator (RFC 8707).** The Test-your-agent flow was looping users back to "Connect via OAuth" after a successful authorization. Tokens were being saved correctly, but the issued access token's `aud` claim didn't match the MCP resource server, so the agent rejected every subsequent bearer-token request with a 401 — which the storyboard probe re-classified as `needs_oauth`, sending the user right back to the same prompt. Per the MCP authorization spec (2025-06+), the authorization request and the token exchange must include a `resource` parameter (RFC 8707). We now compute the canonical resource URI from the agent URL and forward it on both legs of the flow, plus advertise `scope` from the discovered metadata when present.

2. **Honest opt-out UX.** The "Every 12h" interval dropdown stayed enabled even when the agent was `opted_out`, suggesting scheduled checks would run when the heartbeat actually skips opted-out agents entirely. Disable both the Pause toggle and the interval dropdown when `compliance_opt_out = true`, and surface a "monitoring opted out" hint pointing to the "Show on registry" toggle as the way to re-enable.
