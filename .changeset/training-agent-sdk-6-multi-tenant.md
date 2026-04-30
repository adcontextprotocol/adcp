---
---

Migrate the training agent to `@adcp/sdk@6.0.0` and split it into six per-specialism tenants.

**SDK migration:** package renamed `@adcp/client@5.21.0` → `@adcp/sdk@^6.0.0`. 159 imports across `server/src` and `server/tests` updated. `createAdcpServer` (v5) imports moved to `@adcp/sdk/server/legacy/v5`. Resolves from npm registry; no worktree link.

**Multi-tenant training agent:** the single `/api/training-agent/mcp` URL is replaced with six per-specialism tenants — `/sales`, `/signals`, `/governance`, `/creative`, `/creative-builder`, `/brand` — each declaring its own specialism via the v6 `DecisioningPlatform` interface. Routing works for both the local mount (`/api/training-agent/<tenant>/mcp`) and host-based dispatch (`test-agent.adcontextprotocol.org/<tenant>/mcp`).

**Back-compat alias:** the legacy `/api/training-agent/mcp` continues to serve the v5 single-URL behavior with `Deprecation: true` and a `Link: rel="successor-version"` header pointing at `adagents.json`. AAO entries, Sage/Addie configs, docs, and external storyboard runners keep working unchanged on day 1; references migrate to per-tenant URLs over time.

**Error code canonicalization (F15):** lowercase v5-era codes (`brand_not_found`, `validation_error`, `not_found`, `invalid_request`, etc.) replaced with canonical uppercase codes (`BRAND_NOT_FOUND`, `VALIDATION_ERROR`, `REFERENCE_NOT_FOUND`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `INVALID_REQUEST`).

**Removed:** `framework-server.ts`, `v6-server.ts`, `v6-*.test.ts`, SSE/strict integration tests, framework-comply unit test — all rolled into the multi-tenant architecture.

371/371 tests passing. Storyboards 55–59/62 clean per tenant against AdCP 3.0.1 conformance suite.

Documentation references to the legacy URL (docs/, learning specialist pages, quickstart) are tracked as a separate follow-up PR.
