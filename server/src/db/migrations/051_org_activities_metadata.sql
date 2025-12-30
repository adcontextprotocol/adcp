-- Migration: 048_org_activities_metadata.sql
-- Add metadata JSONB column to org_activities for storing structured data
-- Useful for email details (subject, from, message_id), slack thread info, etc.

ALTER TABLE org_activities ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Index for querying metadata (e.g., finding by message_id for deduplication)
CREATE INDEX IF NOT EXISTS idx_org_activities_metadata ON org_activities USING GIN (metadata);

COMMENT ON COLUMN org_activities.metadata IS 'Structured metadata for the activity (e.g., email subject/from/message_id, slack thread_ts)';
