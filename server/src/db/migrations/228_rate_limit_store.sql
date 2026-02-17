-- Migration: 228_rate_limit_store.sql
-- PostgreSQL-backed rate limit store for multi-instance support.

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 1,
  reset_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE rate_limit_hits IS 'Rate limit counters shared across application instances';
