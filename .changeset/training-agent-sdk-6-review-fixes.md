---
---

Address expert review punch list on the training-agent multi-tenant migration (`7974aeccd8`).

**Schema-conformant adagents.json**
- `/signals/mcp` entry now uses `authorization_type: 'signal_tags'` (the schema discriminator for signals agents) instead of `inline_properties`.
- Added `_training_agent_tenants` discovery extension listing all six per-specialism tenants with their URLs and specialisms — surfaces governance/creative/creative-builder/brand which don't fit the schema's `authorized_agents` discriminator.

**Security hardening**
- `noopJwksValidator` now throws at boot if `NODE_ENV=production` without an explicit `ALLOW_NOOP_JWKS_VALIDATOR=1` opt-in.
- Per-tenant signing kid generated via `randomBytes(4)` instead of `Math.random()`.
- `comply.ts` hardcoded principal documented as an SDK gap (ComplyControllerContext doesn't expose authInfo); session-state semantics in `tenants/registry.ts` doc-comment updated to be honest about cross-tenant shared state being intentional for sandbox scenarios.

**Test/dev URL surfaces**
- `PUBLIC_TEST_AGENT.url` defaults to `/sales/mcp` (the most common tenant for media-buy testing); `PUBLIC_TEST_AGENT_URLS` exposes all six per-specialism URLs plus the legacy alias.
- Addie's `member-tools.ts` redirect for `INTERNAL_PATH_AGENT_URL` now targets the legacy back-compat alias (preserves single-URL multi-tool semantics) instead of routing to a single specialism.

**Polish**
- Stale `tenants/registry.ts` header comment refreshed (was "Five tenants" + "only /signals registered"; now describes all six and the path-routing model).
- 3 `console.log` calls in `tenants/tenant-smoke.test.ts` removed.

**Deferred to upstream (filed as SDK feedback)**
- Wrong-tenant DX hint (`Tool 'X' lives on /sales/mcp`) — first attempt regressed `creative-builder` storyboards by 1 because the SDK storyboard runner's missing-tool detection (`/Unknown tool[:\s]/i` + `!taskResult`) doesn't classify any of `result.isError`, JSON-RPC `error`, or `adcp_error`-wrapped responses as a graceful skip. Needs SDK adjustment before we can ship the hint.
- `BRAND_NOT_FOUND` vs `REFERENCE_NOT_FOUND`: the SDK's bundled brand storyboard fixture explicitly enumerates `BRAND_NOT_FOUND` as canonical, contradicting universal `error-handling.mdx` which puts brands in the `REFERENCE_NOT_FOUND` fallback list. Kept `BRAND_NOT_FOUND` for storyboard conformance; filed feedback to reconcile the spec.
