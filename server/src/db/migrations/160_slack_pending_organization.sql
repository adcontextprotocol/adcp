-- Migration: 160_slack_pending_organization.sql
-- Add pending_organization_id to track which prospect a Slack user is associated with
-- before they've fully joined (e.g., discovered via domain discovery)

ALTER TABLE slack_user_mappings
ADD COLUMN IF NOT EXISTS pending_organization_id VARCHAR(255);

-- Index for querying pending users by organization
CREATE INDEX IF NOT EXISTS idx_slack_mapping_pending_org
  ON slack_user_mappings(pending_organization_id)
  WHERE pending_organization_id IS NOT NULL AND mapping_status = 'unmapped';

-- Index for efficient email domain lookups when linking users
CREATE INDEX IF NOT EXISTS idx_slack_mapping_email_domain
  ON slack_user_mappings(LOWER(SPLIT_PART(slack_email, '@', 2)))
  WHERE mapping_status = 'unmapped' AND slack_is_bot = false AND slack_is_deleted = false;

COMMENT ON COLUMN slack_user_mappings.pending_organization_id IS
  'Organization ID that this unmapped user is associated with (e.g., via domain discovery). Used to show pending user counts on prospects before users formally join.';
