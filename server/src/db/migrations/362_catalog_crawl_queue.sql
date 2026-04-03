-- Queue for demand-driven adagents.json crawling of catalog properties.
-- Domains are enqueued when they appear as "known" in bulk checks.
-- The crawler processes the queue periodically, with exponential backoff
-- for domains where adagents.json is not found.

CREATE TABLE catalog_crawl_queue (
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  last_crawled_at TIMESTAMPTZ,
  found_adagents BOOLEAN NOT NULL DEFAULT FALSE,
  next_crawl_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  crawl_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (identifier_type, identifier_value)
);

CREATE INDEX idx_crawl_queue_next ON catalog_crawl_queue (next_crawl_after)
  WHERE found_adagents = FALSE;
