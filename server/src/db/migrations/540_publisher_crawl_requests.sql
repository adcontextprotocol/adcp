-- Durable lifecycle for explicit publisher recrawl requests (#6325).
--
-- API admission persists a row before returning 202. Workers claim due rows
-- with a bounded lease, perform origin/network work outside the transaction,
-- then record a terminal outcome or schedule a bounded retry.

CREATE TABLE publisher_crawl_requests (
  id UUID PRIMARY KEY,
  publisher_domain TEXT NOT NULL CHECK (char_length(publisher_domain) BETWEEN 1 AND 253),
  source TEXT NOT NULL DEFAULT 'api:crawl-request' CHECK (char_length(source) BETWEEN 1 AND 100),
  requester_type TEXT NOT NULL CHECK (requester_type IN ('user', 'static_admin')),
  requested_by_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'deferred', 'retrying', 'completed', 'invalid', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT publisher_crawl_requester_identity CHECK (
    (requester_type = 'user' AND requested_by_user_id IS NOT NULL)
    OR (requester_type = 'static_admin' AND requested_by_user_id IS NULL)
  ),
  CONSTRAINT publisher_crawl_lease_shape CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_publisher_crawl_requests_due
  ON publisher_crawl_requests (available_at, created_at)
  WHERE status IN ('queued', 'deferred', 'retrying');

CREATE INDEX idx_publisher_crawl_requests_expired_lease
  ON publisher_crawl_requests (lease_expires_at)
  WHERE status = 'running';

CREATE INDEX idx_publisher_crawl_requests_domain_created
  ON publisher_crawl_requests (publisher_domain, created_at DESC);

CREATE INDEX idx_publisher_crawl_requests_user_created
  ON publisher_crawl_requests (requested_by_user_id, created_at DESC)
  WHERE requested_by_user_id IS NOT NULL;

COMMENT ON TABLE publisher_crawl_requests IS
  'Durable, client-visible lifecycle for explicit publisher recrawls. Terminal rows are retained temporarily for status and audit, then removed by the worker retention sweep.';
