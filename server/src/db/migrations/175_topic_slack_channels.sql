-- Migration: 173_topic_slack_channels.sql
-- Allow topics to have their own Slack channels for targeted meeting invitations

-- =====================================================
-- MEETING SERIES: Add slack_channel invite mode
-- =====================================================

-- Drop and recreate the invite_mode constraint to include 'slack_channel'
ALTER TABLE meeting_series
DROP CONSTRAINT IF EXISTS meeting_series_invite_mode_check;

ALTER TABLE meeting_series
ADD CONSTRAINT meeting_series_invite_mode_check
CHECK (invite_mode IN ('all_members', 'topic_subscribers', 'slack_channel', 'manual'));

-- Add column for explicit Slack channel to invite from
ALTER TABLE meeting_series
ADD COLUMN IF NOT EXISTS invite_slack_channel_id VARCHAR(50);

COMMENT ON COLUMN meeting_series.invite_slack_channel_id IS 'Slack channel ID to pull invitees from when invite_mode is slack_channel';

-- Note: working_groups.topics is JSONB, so adding slack_channel_id to topic objects
-- doesn't require a schema change - it's just an optional field in the JSON structure.
-- Topic structure: {slug, name, description?, slack_channel_id?}
