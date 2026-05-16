---
---

Hotfix for the deploy-smoke gate added in #3879. The first deploy that ran it tripped on every per-tenant URL: SDK v6's auth middleware returns `403 Forbidden` for an invalid bearer token (the gate's secret was misconfigured), where v5 returned `401 Unauthorized`. The smoke only accepted `200|401`, so all six per-tenant URLs failed and the deploy went red even though every tenant was healthy (verified out-of-band: 7/7 paths returned 200 with their expected tool counts using the documented public token).

Accepts `403` alongside `200` and `401`. All three mean "registry resolved, MCP route alive" — which is what this smoke is checking. The bug modes it protects against (`404 Tenant not registered`, `5xx` registry init failure) happen before auth and are unaffected.
