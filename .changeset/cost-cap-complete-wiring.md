---
---

Complete the per-user Anthropic cost-cap wiring (#2950, follow-up to #2946).

**Security:** the email conversation handler was the highest-priority unwired
path — inbound From-header auth is spoofable, so a cooperative mail server
could previously hit Claude uncapped. Now bucketed by sha256-hashed From
address under the `anonymous` tier.

**Wired callers:**
- `server/src/addie/email-conversation-handler.ts` — `email:${sha256(from).slice(0,16)}` scope, `anonymous` tier
- `server/src/routes/tavus.ts` — resolves `thread.user_id` → `member_free`; falls back to `uncapped: true` (Bearer-auth bounds the surface)
- `server/src/mcp/chat-tool.ts` — external partners via safe-tools-only → explicit `uncapped: true`
- `server/src/addie/bolt-app.ts` — 5 Slack sites (mention, DM, thread reply, proposed-channel, reaction) scoped by WorkOS id or `slack:${userId}` fallback, `member_free` tier

**Fail-closed default:** `AddieClaudeClient` now logs
`event: 'cost_cap_unwired'` at `warn` level when `processMessage` /
`processMessageStream` is called with neither `costScope` nor `uncapped: true`.
Log aggregation can alert on this event so future unwired callers don't ship
silently. Tests pin both the warn-fires-on-missing case and the suppressed
case when `uncapped: true` is set.
