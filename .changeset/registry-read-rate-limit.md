---
---

fix(server): per-IP rate limit on unauthenticated registry-read endpoints, closes #4112

Adds two rate limiters to `server/src/middleware/rate-limit.ts` and applies them across the six
unauthenticated registry endpoints that previously had no per-IP cap:

- `registryPublisherRateLimiter` — 20 req/min on `GET /api/registry/publisher`, which fans out
  to up to 50 DB queries per request (agent-rollup cap from PR #4106). Matches the ceiling of
  `bulkResolveRateLimiter` (20 req/min × up to 100 domains) for comparable worst-case DB load.
- `registryReadRateLimiter` — 60 req/min shared across `GET /api/registry/operator`,
  `GET /api/registry/publisher/authorization`, `GET /api/registry/publishers`, and all
  `GET /api/registry/lookup/*` variants. These issue a small fixed number of queries per call.

Both use `CachedPostgresStore` (in-memory increment, 15 s Postgres flush) for cross-pod sync
without saturating the connection pool on high-frequency anonymous reads, matching the pattern
used by `notificationRateLimiter` and `agentReadRateLimiter`.

Note: two other unauthenticated registry endpoints — `/api/registry/stats` and
`/api/registry/agents` — were not in scope for this issue. A follow-up should evaluate
whether they also need caps, particularly `/api/registry/agents` which supports optional
fan-out query params (`health`, `capabilities`, `compliance`).
