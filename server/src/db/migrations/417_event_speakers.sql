-- Event speakers: named people (with optional headshot + bio) associated with
-- an event. Ordered for display; replace-all semantics on write.

CREATE TABLE IF NOT EXISTS event_speakers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  name VARCHAR(255) NOT NULL,
  title VARCHAR(255),
  company VARCHAR(255),
  bio TEXT,
  headshot_url TEXT,
  link_url TEXT,

  display_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_speakers_event_order
  ON event_speakers(event_id, display_order);

CREATE TRIGGER update_event_speakers_updated_at
  BEFORE UPDATE ON event_speakers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE event_speakers IS 'Ordered speaker roster for an event — rendered on /events/{slug} and edited in /admin/events';
COMMENT ON COLUMN event_speakers.headshot_url IS 'Optional URL to a headshot image (hosted externally or uploaded)';
COMMENT ON COLUMN event_speakers.link_url IS 'Optional profile/bio link (LinkedIn, personal site, etc.)';
