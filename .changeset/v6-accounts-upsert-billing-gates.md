---
---

feat(training-agent): wire `accounts.upsert` on all v6 per-tenant routes — billing gates flow through `/api/training-agent/<tenant>/mcp`

Tier-3 follow-up to #3851 (BILLING_NOT_SUPPORTED + BILLING_NOT_PERMITTED_FOR_AGENT gates) — closes the gap that previously left `sync_accounts` exposed only on the deprecated legacy `/mcp` route. Unblocked by SDK 6.7.0's `accounts.upsert(refs, ctx)` ctx-forwarding (filed at adcontextprotocol/adcp-client#1310, shipped as Phase 1 of #1269).

**What landed:**

1. **Shared `accounts.upsert` helper** (`server/src/training-agent/v6-account-helpers.ts`) delegates to the existing v5 `handleSyncAccounts` so capability gate + per-buyer-agent gate semantics are identical on every v6 tenant route as on the legacy `/mcp` route.

2. **All six v6 tenant platforms wire the helper** — sales, signals (in `v6-platform.ts`), governance, creative, creative-builder, brand. `accounts.upsert: syncAccountsUpsert` on each platform's `AccountStore`. Framework auto-registers `sync_accounts` on every per-tenant route now that `upsert` is defined.

3. **Tenant router auth bridge** (`server/src/training-agent/tenants/router.ts`) — bridges `res.locals.trainingPrincipal` (set by the conductor's bearer-auth middleware) onto `req.auth.clientId` so the SDK framework surfaces it as `ctx.authInfo.clientId` to platform handlers. Without this bridge, the framework runs without auth context and per-buyer-agent gates can't read the calling principal — the conductor's auth middleware runs upstream of the framework's MCP transport, which doesn't otherwise see `res.locals`.

4. **Integration test** (`server/src/training-agent/tenants/sync-accounts-gates.test.ts`) — boots the real tenant router, sends real HTTP, asserts the per-buyer-agent gate fires on `/api/training-agent/sales/mcp` with the clamped `error.details` shape, autonomous recovery via `suggested_billing` succeeds, agent-billable bearer accepts all three values, and the uniform-response rule for unrecognized principals holds. Stays in CI permanently.

**Verified end-to-end:** 26 tests pass (4 v6 tenant integration + 22 v5 unit). Full server suite clean (3133 passed, 42 skipped, 0 failed). Type check clean.

**Phase 2 migration path** (when adcp-client `BuyerAgentRegistry` framework-level enforcement lands per #1269 Phase 2): `commercial-relationships.ts` becomes a `BuyerAgentRegistry` adapter, the framework reads `ctx.agent.billing_capabilities` directly, and the `syncAccountsUpsert` helper's gate-replay-via-handleSyncAccounts goes away. Tracked in adcp-client#1310 follow-ups.
