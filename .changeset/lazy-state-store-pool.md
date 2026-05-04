---
---

fix(training-agent): defer pool lookup in pickStateStore so first-attempt boot succeeds

The state-store fix in #4071 unblocked deploys but exposed a boot-ordering
race: `mountTenantRoutes()` runs before `initializeDatabase()`, so the
eager `holder.get()` at boot calls `getPool()` and throws "Database not
initialized." The eager-mount catch resets `pendingInit`, the next
request retries, and by then the pool is up — so production heals
within ~5s. Visible in the post-#4071 deploy logs:

  T+0  init starting → "Database not initialized" (eager fail)
  T+5  init starting → "Tenant registry initialized" totalMs=27 (heals)

Wrap the pool in a lazy `PgQueryable` so `getPool()` runs at first query,
not at construction. Construction now always succeeds; by the time a
tool touches `ctx.store`, the pool is initialized regardless of mount
order. Eliminates one round-trip of boot retry and the noisy first
error.
