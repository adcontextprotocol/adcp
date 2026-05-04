---
---

feat(training-agent): wire BuyerAgentRegistry on all v6 tenants — `ctx.agent.billing_capabilities` populated end-to-end

Phase 1 BuyerAgentRegistry adoption (per `adcp-client#1269`). Unblocked by SDK 6.8.0's `extra`-forwarding fix for `ResolveBuyerAgentByCredential` (the issue I filed at `adcp-client#1484`, fix shipped as `adcp-client#1488`).

**What landed:**

1. **SDK pin bumped to `^6.8.0`.**

2. **Bearer authenticator stamps `extra: { demo_token: token }`** on the AuthPrincipal returned for `demo-*` test bearers (`server/src/training-agent/index.ts`). The token doesn't survive `AdcpCredential` normalization (api_key carries `key_id: SHA-256(token)`); `extra` is the documented escape hatch for prefix-based test conventions.

3. **New `buyer-agent-registry.ts`** — `BuyerAgentRegistry.bearerOnly` resolver that reads `extra.demo_token`, delegates to `commercial-relationships.ts` for the principal → relationship lookup (single source of truth), and returns a `BuyerAgent` record with the appropriate `billing_capabilities` Set. Unrecognized credentials return `null` (uniform-response rule). Signed credentials are refused per the `bearerOnly` factory's posture.

4. **All six v6 tenant platforms wire `agentRegistry: trainingBuyerAgentRegistry`** — sales, signals (in `v6-platform.ts`), governance, creative, creative-builder, brand. The framework calls `agentRegistry.resolve(authInfo)` once per request before `accounts.resolve` and threads the resolved record through `ctx.agent` to platform handlers.

5. **No gate-logic changes.** `commercial-relationships.ts` remains the source of truth and the legacy `/mcp` path keeps consuming it via `handleSyncAccounts`. The v6 platforms now ALSO have `ctx.agent.billing_capabilities` populated — forward-compat for SDK Phase 2 (`adcp-client#1292`) when framework-level enforcement of `BILLING_NOT_PERMITTED_FOR_AGENT` ships and reads from `ctx.agent` directly.

**Why delegate to `commercial-relationships.ts` instead of inlining.** Both the legacy `/mcp` path (via `handleSyncAccounts`) and the v6 path (via `ctx.agent`) need consistent gate decisions. Two source-of-truth modules drift over time. Single delegation through `getCommercialRelationship(principal)` keeps both consumers reading the same data; when SDK Phase 2 lands, the v6 path's manual gate consultation can collapse and `commercial-relationships.ts` becomes a private adapter for the registry.

**Tests.**

- 6 new unit tests in `buyer-agent-registry.test.ts` — passthrough/agent-billable prefix resolution, unrecognized prefix → null, missing extra → null, non-string extra → null, http_sig credential → null (bearerOnly rejection).
- Existing `sync-accounts-gates.test.ts` (4 base + 6 per-tenant + 1 unauth = 11 tests) and `account-handlers.test.ts` (22 tests) all pass — proves the gate logic still fires correctly under the new wiring.
- Full server suite: 3156 passed, 42 skipped, 0 failed (excluding one pre-existing flaky LLM test).

**SDK 6.8.0 sandbox-mode adaptation (related fix bundled).** SDK 6.8.0 added a new `comply_test_controller` gate that requires resolved accounts to be in sandbox or mock mode (`isSandboxOrMockAccount` in `@adcp/sdk/server`). The training-agent operates as a public sandbox by design but didn't communicate that on the wire — `accounts.resolve` returned Account records without `sandbox: true`. With the new gate, every comply controller call would FORBIDDEN-reject. Fixed by adding `sandbox: true` to all six v6 platforms' `accounts.resolve` return values (both the `ref == null` synthetic-public-sandbox path and the brand/operator-resolved path). Pre-push storyboard floors confirm: all six tenants now meet baselines; without this fix the SDK bump would regress every comply-controller-using storyboard.

**Phase 2 outlook.** When SDK Phase 2 ships framework-level enforcement, the only remaining work is to delete the gate logic from `account-handlers.ts` and let the framework reject `BILLING_NOT_PERMITTED_FOR_AGENT` against `ctx.agent.billing_capabilities` directly. The `commercial-relationships.ts` module stays as the registry's data source.
