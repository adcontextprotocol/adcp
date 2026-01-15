-- Migration: 170_slack_activity_index.sql
-- Add index on last_slack_activity_at for HAS_ENGAGED_USER filter performance
--
-- The org-filters.ts HAS_ENGAGED_USER filter uses this column in a date range
-- comparison to identify organizations with recent Slack activity. Without an
-- index, this query scans all slack_user_mappings rows.

-- Note: Not using CONCURRENTLY because migrations run in transactions
-- This table is small enough that the brief lock is acceptable
CREATE INDEX IF NOT EXISTS idx_slack_user_mappings_last_activity
  ON slack_user_mappings(last_slack_activity_at)
  WHERE last_slack_activity_at IS NOT NULL;
