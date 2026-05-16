---
---

feat(crawler): queue-backed re-validation when a manager rotates adagents.json

Closes #4200 item 2. When a manager domain (e.g. Raptive) updates its
`/.well-known/adagents.json`, every publisher delegating via ads.txt
`MANAGERDOMAIN` needs to be re-validated so its `authorized_agents` view
stays in sync. Inline fan-out from the cache write would saturate
crawler concurrency at managed-network scale; this PR adds a persistent
queue and a bounded worker tick.

- Migration 471: `manager_revalidation_queue` table mirroring the shape
  of `catalog_crawl_queue` (idempotent insert, `next_attempt_after` for
  backoff, partial index on `(next_attempt_after, enqueued_at)`).
- `cacheAdagentsManifest` reads the previously-cached body before the
  upsert and compares the contributory subset (`authorized_agents`,
  `properties`) via stable canonicalization. Only actual content drift
  triggers the fan-out; `$schema` / `last_updated` noise is ignored.
- New crawler tick `processManagerRevalidationQueue` drains up to 50
  rows per 5-minute interval at concurrency 10, calling
  `crawlSingleDomain` for each. Success deletes the row; failure
  advances exponential backoff (1h / 6h / 1d / 3d) and stores the last
  error truncated to 500 chars.
- The reverse-index lookup uses the partial index on
  `publishers.manager_domain` added in #4204, so a Raptive-scale
  rotation enumerates 6K delegating publishers via an index-only scan.

Tests: integration coverage for queue idempotency, due-row filtering,
oldest-first ordering, success deletion, and exponential backoff. Unit
coverage for the change-detection helper.
