---
---

Eagerly initialize the training-agent tenant registry at server boot.

Every recent deploy has been failing the post-deploy smoke check on `/sales/mcp`, `/signals/mcp`, `/governance/mcp`, `/creative/mcp`, `/creative-builder/mcp`, and `/brand/mcp` — all returning HTTP 500 during a ~16s window after rolling deploy completes, then healing on their own. The smoke gives up and marks the deploy failed even though production is healthy minutes later.

Root cause: `RegistryHolder` was lazy-initialized on first request. On a fresh Fly machine the 6-tenant registration burst takes 30–60s — longer than the smoke's 16s retry budget. The first probe to a tenant route lands while `register()` calls are still in flight, returns 500 (unhandled init promise resolution), and the retry 8s later catches it in the same state.

Pre-warm the registry inside `mountTenantRoutes` so init starts at server boot, not first request. Per-request handlers continue to await `holder.get()`, which now reuses the in-flight or completed promise from the eager call. Two safety nets:

- **Reject-clear**: `pendingInit` is reset on rejection so a transient init failure doesn't poison every subsequent request with the same rejected promise until machine restart.
- **Eager-init failure logged, not crashed**: if the boot-time init throws, the error is logged and per-request init retries on the next call. Doesn't take down the server.

Drops the unused `req` param from `RegistryHolder.get()` (the comment said it was vestigial; this confirms it).
