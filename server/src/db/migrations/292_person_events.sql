-- Person Events
-- Append-only activity log for every person. Single pane of glass for
-- everything that happens to/with/by a person across all surfaces.
-- Source of truth for replay, debugging, and simulation.

CREATE TABLE IF NOT EXISTS person_events (
  id BIGSERIAL PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES person_relationships(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- What happened
  event_type VARCHAR(50) NOT NULL,
  channel VARCHAR(20),           -- slack, email, web, system

  -- Flexible payload keyed by event_type
  data JSONB NOT NULL DEFAULT '{}',

  -- Write-once
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query: all events for a person, chronological
CREATE INDEX IF NOT EXISTS idx_person_events_person_time
  ON person_events(person_id, occurred_at);

-- Find events by type across all people (analytics, debugging)
CREATE INDEX IF NOT EXISTS idx_person_events_type_time
  ON person_events(event_type, occurred_at);

-- Per-person event type queries (e.g., count messages sent to person)
CREATE INDEX IF NOT EXISTS idx_person_events_person_type
  ON person_events(person_id, event_type);

-- Recent events across all people (admin dashboard, monitoring)
CREATE INDEX IF NOT EXISTS idx_person_events_occurred_desc
  ON person_events(occurred_at DESC);

-- Add unreplied_outreach_count to person_relationships for annoyance cascade prevention
ALTER TABLE person_relationships
  ADD COLUMN IF NOT EXISTS unreplied_outreach_count INTEGER NOT NULL DEFAULT 0;

-- Backfill unreplied counts: count messages Addie sent that got no reply
-- (person was messaged but last_person_message_at is before last_addie_message_at or null)
UPDATE person_relationships
SET unreplied_outreach_count = CASE
  WHEN last_addie_message_at IS NOT NULL
    AND (last_person_message_at IS NULL OR last_person_message_at < last_addie_message_at)
  THEN 1  -- conservative: assume at most 1 unreplied
  ELSE 0
END
WHERE last_addie_message_at IS NOT NULL;
