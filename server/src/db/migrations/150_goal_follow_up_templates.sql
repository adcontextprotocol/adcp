-- Migration: 148_goal_follow_up_templates.sql
-- Add follow-up message templates for gentle reminders on unanswered outreach

-- Add follow_up_template column to goals
-- This is sent when user hasn't responded after the initial outreach
ALTER TABLE outreach_goals
ADD COLUMN IF NOT EXISTS follow_up_template TEXT,
ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 2,
ADD COLUMN IF NOT EXISTS days_between_attempts INTEGER DEFAULT 7;

COMMENT ON COLUMN outreach_goals.follow_up_template IS 'Gentler message for follow-up attempts after no response';
COMMENT ON COLUMN outreach_goals.max_attempts IS 'Maximum number of outreach attempts for this goal (default 2)';
COMMENT ON COLUMN outreach_goals.days_between_attempts IS 'Days to wait before follow-up attempt (default 7)';

-- Update existing goals with follow-up templates
UPDATE outreach_goals SET follow_up_template =
  E'{{user_name}} - Just a quick follow-up on linking your account. This one-click step unlocks the full member experience:\n\n{{link_url}}\n\nNo pressure - just didn''t want it to slip through the cracks!'
WHERE name = 'Link Account';

UPDATE outreach_goals SET follow_up_template =
  E'{{user_name}} - Circling back on my earlier question about your role. Understanding whether you''re more technical, business, or leadership helps me point you to the most relevant resources.\n\nNo worries if you''re too busy - just let me know and I''ll check back another time.'
WHERE name = 'Learn Role';

UPDATE outreach_goals SET follow_up_template =
  E'{{user_name}} - Following up on what {{company_name}} is focused on this year. I''d love to connect you with relevant working groups or councils, but I need to understand your priorities first.\n\nEven a quick one-liner helps!'
WHERE name = 'Learn 2025/2026 Goals';

UPDATE outreach_goals SET follow_up_template =
  E'{{user_name}} - Just checking in on my question about your interests. Knowing whether you''re focused on sustainability, open web, measurement, privacy, or AI helps me make better recommendations.\n\nFeel free to just list a couple topics if that''s easier!'
WHERE name = 'Learn Interests';
