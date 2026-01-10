-- Add timezone offset column to slack_user_mappings
-- Slack provides tz_offset in seconds from UTC

ALTER TABLE slack_user_mappings
ADD COLUMN IF NOT EXISTS slack_tz_offset INTEGER;

COMMENT ON COLUMN slack_user_mappings.slack_tz_offset IS 'Timezone offset in seconds from UTC, from Slack user profile';
