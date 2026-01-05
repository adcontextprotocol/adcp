-- Migration: 133_external_event_registration.sql
-- Add support for external event registration URLs (for third-party events like CES, Cannes Lions, etc.)

-- Add external registration URL field to events
ALTER TABLE events ADD COLUMN IF NOT EXISTS external_registration_url TEXT;

-- Add a flag to indicate this is an external/third-party event (not managed by AAO)
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_external_event BOOLEAN DEFAULT FALSE;

-- Comments
COMMENT ON COLUMN events.external_registration_url IS 'External registration URL for third-party events (CES, Cannes Lions, etc.)';
COMMENT ON COLUMN events.is_external_event IS 'True if this is a third-party event not managed by AAO';
