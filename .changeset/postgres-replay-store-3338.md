---
---

fix(training-agent): swap to PostgresReplayStore so vector 016 catches cross-instance replays

The per-route fix in #3346 closed the cross-route bug but vector 016 still failed in prod. Root cause: Fly runs `min_machines_running = 2` web machines and the per-process `InMemoryReplayStore` can't see across machines. Probe 1 hits machine A and consumes the nonce; probe 2 gets routed to machine B by the LB, machine B has never seen the nonce locally, accepts it.

Swaps `InMemoryReplayStore` for `PostgresReplayStore` from `@adcp/client/signing/server` (5.21.0+, [adcp-client#1018](https://github.com/adcontextprotocol/adcp-client/pull/1018)). All instances share one `adcp_replay_cache` table, so the replay window holds across the LB.

Adds:
- Migration `447_adcp_replay_cache.sql` — schema mirrors the SDK's `getReplayStoreMigration()` output: `(keyid, scope, nonce)` PK + `expires_at` TTL column, two indexes for the lookup and sweep paths.
- `startReplayCacheSweeper()` in `request-signing.ts` and `index.ts` boot wiring — runs `sweepExpiredReplays(pool)` every 60s. Postgres has no native TTL; without sweeping the table grows unboundedly.

Singleton replay store across the per-route authenticators (default / strict / strict-required / strict-forbidden) — the (keyid, scope, nonce) primary key already partitions by route via the `@target-uri`-derived scope, so a shared table is safe and avoids four separate connections.

Closes the remaining piece of #3338. Once deployed, grader vector 016 should pass against `/mcp-strict`, completing 33/33 graded vectors across the four strict-mode routes.
