-- Queue for fanning out re-validation when a manager domain rotates its
-- adagents.json. Item 2 of #4200, follow-up to #4173 / #4204.
--
-- Why a queue: at managed-network scale a single manager (e.g. Raptive)
-- can have thousands of delegating publishers. Inline fan-out from a
-- crawlSingleDomain() that detects change would saturate the crawler's
-- concurrency budget. Persisting the work and draining it at a bounded
-- rate per tick keeps the crawler stable while still propagating manager
-- updates within a small number of crawl cycles.
--
-- Mirrors the shape of catalog_crawl_queue (migration 367):
--   - identifier as primary key, idempotent insert
--   - next_attempt_after for backoff windowing
--   - worker pulls WHERE next_attempt_after <= NOW() ORDER BY ... LIMIT N

CREATE TABLE manager_revalidation_queue (
  publisher_domain TEXT PRIMARY KEY,
  manager_domain TEXT NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  last_error TEXT
);

-- Worker query: oldest-first pull of due rows. Partial index keeps the
-- scan cheap even when the queue carries lots of rows in deep backoff.
CREATE INDEX idx_manager_revalidation_queue_due
  ON manager_revalidation_queue (next_attempt_after, enqueued_at);

-- Per-manager scan: lets ops see how many publishers are still pending
-- for a given manager and supports the optional /api/registry/managers
-- /:domain/recrawl endpoint planned in #4200 item 5.
CREATE INDEX idx_manager_revalidation_queue_manager
  ON manager_revalidation_queue (manager_domain);

COMMENT ON TABLE manager_revalidation_queue IS
  'Pending re-validations triggered by a manager rotating its adagents.json. Drained by the crawler at a bounded rate per tick. Rows are deleted on successful re-validation; failures advance next_attempt_after with exponential backoff.';
