---
---

Hotfix: per-tenant POSTs returned HTTP 500 in production after the multi-tenant migration (#3713) deployed. SDK 6.0 refuses the default in-memory task registry under `NODE_ENV=production`, and we never passed an explicit `taskRegistry` — registry init threw at first request, every per-tenant POST surfaced as `Internal Server Error`. Legacy `/mcp` was unaffected (uses the v5 `createTrainingAgentServer` path).

Wire `createPostgresTaskRegistry({ pool: getPool() })` into the tenant registry's default server options. Test/dev fall back to `createInMemoryTaskRegistry()` because the test harness doesn't initialize the postgres pool. Production failure is fail-loud-with-fallback: if the pool is missing or the migration hasn't run, log error and fall back to in-memory rather than booting broken.

Postgres-backed registry is also the correct choice independently of the SDK guard — the AAO app runs multiple Fly machines, and the in-memory registry is process-local. A buyer creating a media buy on machine A and polling on machine B would otherwise see task-not-found on ~50% of polls.

Migration `463_adcp_decisioning_tasks.sql` is the SDK-shipped DDL from `getDecisioningTaskRegistryMigration()` (verbatim — `CREATE TABLE IF NOT EXISTS adcp_decisioning_tasks` plus two supporting indexes). Idempotent.
