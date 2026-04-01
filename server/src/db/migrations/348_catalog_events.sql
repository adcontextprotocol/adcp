-- Append-only event log for the property catalog and registry.
-- Events are written in the same transaction as the mutations they describe.
-- Consumers poll the feed via cursor (UUID v7 ordering).

CREATE TABLE IF NOT EXISTS catalog_events (
  event_id    UUID PRIMARY KEY,               -- UUID v7, time-ordered
  event_type  TEXT NOT NULL,                   -- e.g. property.created, authorization.granted
  entity_type TEXT NOT NULL,                   -- property, agent, publisher, authorization, catalog
  entity_id   TEXT NOT NULL,                   -- primary identifier for the affected entity
  payload     JSONB NOT NULL DEFAULT '{}',     -- event-specific data
  actor       TEXT NOT NULL,                   -- who/what caused the event (member_id, pipeline:crawler, etc.)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feed query: WHERE event_id > $cursor ORDER BY event_id LIMIT $n
-- UUID v7 ordering matches created_at ordering by construction.
CREATE INDEX IF NOT EXISTS idx_catalog_events_type ON catalog_events (event_type text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_catalog_events_entity ON catalog_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_catalog_events_created ON catalog_events (created_at);
