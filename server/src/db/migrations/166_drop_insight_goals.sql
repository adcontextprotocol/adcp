-- Migration: Drop insight_goals table
--
-- The insight_goals table was used for passive insight extraction during conversations.
-- It has been superseded by outreach_goals which now serves as the single source of truth
-- for both proactive outreach and passive extraction goals.
--
-- This migration:
-- 1. Drops the insight_goal_progress view (depended on insight_goals)
-- 2. Drops the FK constraint from member_outreach.insight_goal_id
-- 3. Drops the insight_goal_id column from member_outreach (no longer used)
-- 4. Drops the insight_goals table

-- Drop the view that depended on insight_goals
DROP VIEW IF EXISTS insight_goal_progress;

-- Drop the FK constraint and column from member_outreach
-- The insight_goal_id was never used by the planner-based outreach system
ALTER TABLE member_outreach DROP COLUMN IF EXISTS insight_goal_id;

-- Drop indexes on insight_goals
DROP INDEX IF EXISTS idx_goals_active;
DROP INDEX IF EXISTS idx_goals_campaign_dates;
DROP INDEX IF EXISTS idx_goals_priority;

-- Drop the insight_goals table
DROP TABLE IF EXISTS insight_goals;

COMMENT ON TABLE outreach_goals IS 'Goals for member outreach and passive insight extraction. Single source of truth for what Addie wants to learn about members.';
