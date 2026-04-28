---
---

fix(training-agent): InMemoryReplayStore fallback when no Postgres pool (test/dev only)

#3351 swapped to `PostgresReplayStore` to close the cross-instance replay gap. That worked in production but broke the storyboard runner: CI runs the full server in-process without initializing a Postgres pool, and `getReplayStore()` was unconditionally calling `getPool()` which throws.

Symptom: `signed_requests` storyboard regressed from `31P / 9S / 0N/A` to `3P / 28F / 9S` — every positive vector returned 401 because `PostgresReplayStore.insert` rejected on the unavailable pool, and the verifier failed closed.

Fix: `getReplayStore()` now falls back to `InMemoryReplayStore` when `getPool()` throws — gated on `NODE_ENV !== 'production'` so a misconfigured prod still fails loudly. The sweeper is a silent no-op when no pool is initialized. Reset hook in `resetRequestSigning()` clears the cached store so test suites that swap process state stay coherent.

Production unaffected: prod always has a Postgres pool, so `PostgresReplayStore` is used and cross-instance replay protection holds. Verified via `adcp grade request-signing https://agenticadvertising.org/api/training-agent/mcp-strict --only 016-replayed-nonce` → still PASS.
