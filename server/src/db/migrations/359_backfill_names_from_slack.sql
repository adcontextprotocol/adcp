-- Migration: Backfill empty user names from Slack profiles
-- Users who signed up via WorkOS without providing their name have empty
-- first_name/last_name, causing display names to fall back to email prefix.
-- Fill from Slack real_name when available.

UPDATE users u
SET
  first_name = SPLIT_PART(TRIM(sm.slack_real_name), ' ', 1),
  last_name = CASE
    WHEN POSITION(' ' IN TRIM(sm.slack_real_name)) > 0
    THEN SUBSTRING(TRIM(sm.slack_real_name) FROM POSITION(' ' IN TRIM(sm.slack_real_name)) + 1)
    ELSE NULL
  END,
  updated_at = NOW()
FROM slack_user_mappings sm
WHERE sm.slack_user_id = u.primary_slack_user_id
  AND (u.first_name IS NULL OR TRIM(u.first_name) = '')
  AND (u.last_name IS NULL OR TRIM(u.last_name) = '')
  AND sm.slack_real_name IS NOT NULL
  AND TRIM(sm.slack_real_name) != '';
