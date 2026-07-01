-- Supports type-filtered registry feed freshness lookups and SSE heartbeats.
CREATE INDEX IF NOT EXISTS idx_catalog_events_type_created
  ON catalog_events (event_type text_pattern_ops, created_at DESC);
