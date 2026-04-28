---
---

fix(training-agent): fall back to InMemoryReplayStore when no DB is initialized

The storyboard CI runner starts the training-agent without a Postgres database,
so `getPool()` threw "Database not initialized" on every signed request, causing
all 28 positive `signed_requests` storyboard vectors to return 401.

Restores pre-#3351 CI behavior: each authenticator gets its own `InMemoryReplayStore`
when no DB is present, preserving per-route replay isolation without requiring Postgres.
In production (DB initialized), the shared `PostgresReplayStore` singleton is unchanged.

Also guards `startReplayCacheSweeper()` to no-op when no DB is available.

Fixes the `signed_requests` storyboard regression introduced by #3351; unblocks
all PRs against main including #3373 (3.0.1 release prep).
