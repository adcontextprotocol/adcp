-- ============================================================================
-- Migration: 132_cleanup_year_references.sql
-- Description: Clean up old 2025/2026 references from early migrations
--
-- Migration 127 created "Learn 2025/2026 Goals" with insight type "goals_2025"
-- Migration 129 added "Learn 2026 Plans" with "plans_2026" which is better
-- Migration 130 added the plans_2026 insight type
--
-- This migration:
-- 1. Disables the old "Learn 2025/2026 Goals" goal (keep for history)
-- 2. Updates the insight type name from goals_2025 to plans_2025 for clarity
-- 3. Adds admin_context insight type for admin-provided context
-- ============================================================================

-- Disable the old goal so it's not selected by planner
-- We keep it rather than delete because there may be history records
UPDATE outreach_goals
SET is_enabled = FALSE
WHERE name = 'Learn 2025/2026 Goals';

-- Rename the old insight type for clarity (2025 data stays as 2025)
UPDATE member_insight_types
SET name = 'plans_2025',
    description = 'Member plans for agentic advertising in 2025 (historical)'
WHERE name = 'goals_2025';

-- Add admin_context insight type if not exists
INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
SELECT
  'admin_context',
  'Context provided by admin about this member',
  ARRAY['Focused on publisher sales agent implementation', 'High likelihood of membership', 'Key contact at company'],
  TRUE,
  'system'
WHERE NOT EXISTS (
  SELECT 1 FROM member_insight_types WHERE name = 'admin_context'
);
