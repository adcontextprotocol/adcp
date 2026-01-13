-- Migration: 151_consolidate_slack_workos_ids.sql
-- Consolidate duplicate membership and leader records where users have both Slack and WorkOS IDs
--
-- Problem: Users who joined via Slack and later linked their WorkOS account have duplicate records.
-- The same user appears with their Slack ID (e.g., U123) and their WorkOS ID (e.g., user_abc).
-- The slack_user_mappings table links these together.
--
-- Solution: Delete duplicates first (where both Slack and WorkOS records exist), then update remaining records.

-- Step 1: Delete the Slack-ID-based membership records where a WorkOS-ID-based record already exists
-- This handles the case where both U123 and user_abc records exist for the same user/group
DELETE FROM working_group_memberships wgm_slack
WHERE EXISTS (
  SELECT 1 FROM slack_user_mappings sm
  WHERE wgm_slack.workos_user_id = sm.slack_user_id
    AND sm.workos_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM working_group_memberships wgm_workos
      WHERE wgm_workos.working_group_id = wgm_slack.working_group_id
        AND wgm_workos.workos_user_id = sm.workos_user_id
    )
);

-- Step 2: Now safely update remaining Slack IDs to WorkOS IDs (no duplicates possible)
UPDATE working_group_memberships wgm
SET workos_user_id = sm.workos_user_id
FROM slack_user_mappings sm
WHERE wgm.workos_user_id = sm.slack_user_id
  AND sm.workos_user_id IS NOT NULL;

-- Step 3: Delete the Slack-ID-based leader records where a WorkOS-ID-based record already exists
DELETE FROM working_group_leaders wgl_slack
WHERE EXISTS (
  SELECT 1 FROM slack_user_mappings sm
  WHERE wgl_slack.user_id = sm.slack_user_id
    AND sm.workos_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM working_group_leaders wgl_workos
      WHERE wgl_workos.working_group_id = wgl_slack.working_group_id
        AND wgl_workos.user_id = sm.workos_user_id
    )
);

-- Step 4: Now safely update remaining Slack IDs to WorkOS IDs (no duplicates possible)
UPDATE working_group_leaders wgl
SET user_id = sm.workos_user_id
FROM slack_user_mappings sm
WHERE wgl.user_id = sm.slack_user_id
  AND sm.workos_user_id IS NOT NULL;

-- Log the migration completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 151: Consolidated Slack/WorkOS user IDs in working_group_memberships and working_group_leaders';
END $$;
