-- Track failed registry lookups to surface demand for missing brands and properties.
-- Enables prioritization: which domains are people searching for that we don't have?

CREATE TABLE registry_requests (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('brand', 'property')),
  domain TEXT NOT NULL CHECK (length(domain) <= 253 AND domain = lower(domain)),
  first_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  resolved_to_domain TEXT,
  PRIMARY KEY (entity_type, domain)
);

-- List unresolved requests by demand (most-requested first), partitioned by type
CREATE INDEX idx_registry_requests_unresolved
  ON registry_requests(entity_type, request_count DESC)
  WHERE resolved_at IS NULL;
