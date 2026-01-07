-- Migration: 149_consolidate_slack_workos_ids.sql
-- Consolidate duplicate membership and leader records where users have both Slack and WorkOS IDs
--
-- Problem: Users who joined via Slack and later linked their WorkOS account have duplicate records.
-- The same user appears with their Slack ID (e.g., U123) and their WorkOS ID (e.g., user_abc).
-- The slack_user_mappings table links these together.
--
-- Solution: Update all records to use the canonical WorkOS user ID, then remove duplicates.

-- Step 1: Update working_group_memberships to use WorkOS user IDs where mappings exist
-- This converts Slack IDs to their linked WorkOS IDs
UPDATE working_group_memberships wgm
SET workos_user_id = sm.workos_user_id
FROM slack_user_mappings sm
WHERE wgm.workos_user_id = sm.slack_user_id
  AND sm.workos_user_id IS NOT NULL;

-- Step 2: Remove duplicate memberships after consolidation
-- Keep the oldest record (first joined) when duplicates exist
DELETE FROM working_group_memberships wgm1
WHERE EXISTS (
  SELECT 1 FROM working_group_memberships wgm2
  WHERE wgm1.working_group_id = wgm2.working_group_id
    AND wgm1.workos_user_id = wgm2.workos_user_id
    AND wgm1.id > wgm2.id  -- Keep the older record
);

-- Step 3: Update working_group_leaders to use WorkOS user IDs where mappings exist
UPDATE working_group_leaders wgl
SET user_id = sm.workos_user_id
FROM slack_user_mappings sm
WHERE wgl.user_id = sm.slack_user_id
  AND sm.workos_user_id IS NOT NULL;

-- Step 4: Remove duplicate leaders after consolidation
-- Keep the oldest record when duplicates exist
DELETE FROM working_group_leaders wgl1
WHERE EXISTS (
  SELECT 1 FROM working_group_leaders wgl2
  WHERE wgl1.working_group_id = wgl2.working_group_id
    AND wgl1.user_id = wgl2.user_id
    AND wgl1.created_at > wgl2.created_at  -- Keep the older record
);

-- Log the migration completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 149: Consolidated Slack/WorkOS user IDs in working_group_memberships and working_group_leaders';
END $$;
