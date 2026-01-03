-- Add event_id to perspectives for linking content to events
-- Allows event recaps, photos, videos to be associated with specific events

ALTER TABLE perspectives
ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_perspectives_event_id ON perspectives(event_id);

COMMENT ON COLUMN perspectives.event_id IS 'Optional link to an event for recaps, photos, videos';
