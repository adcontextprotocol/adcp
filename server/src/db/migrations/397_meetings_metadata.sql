-- Add metadata column to meetings for tracking nudge state and other extensible data.
-- Mirrors the pattern used by the events table.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
