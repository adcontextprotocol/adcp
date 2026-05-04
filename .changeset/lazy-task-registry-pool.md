---
---

fix(training-agent): defer pool lookup in pickTaskRegistry so production actually uses Postgres on cold boot

Same boot-ordering issue the state-store fix in #4072 closed: `mountTenantRoutes()`
runs before `initializeDatabase()`, so `getPool()` at construction throws
"Database not initialized." `pickTaskRegistry`'s try/catch silently
falls back to the in-memory task registry — meaning every cold-booted
production machine has been running with `InMemoryTaskRegistry` since
#463 shipped, defeating the whole point of `adcp_decisioning_tasks`.
Buyer creates a media buy on machine A, polls on machine B, sees
"task not found" with ~50% probability.

Surfaced by the diagnostic logging from #4067 — the post-#4072 deploy
log showed:

```
"Database not initialized" at pickTaskRegistry (registry.js:124)
```

immediately followed by the success path (state-store now lazy, so
init completes — but task registry was already swapped to in-memory).

Wrap the pool in the same lazy `PgQueryable` adapter `pickStateStore`
uses. `getPool()` runs at first query, by which time the DB is up.
The Postgres backend now actually gets used in production.
