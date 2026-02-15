-- Migration: 212_community_outreach_goals.sql
-- Outreach goals for community platform onboarding.
-- Addie uses these to proactively nudge users to set up community profiles.
-- Goals are inserted as DISABLED. Enable them via admin once the community feature is announced.

-- ============================================================================
-- GOAL 1: Join the community directory (for mapped users without public profiles)
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, is_enabled, created_by)
VALUES
  (
    'Join Community Directory',
    'admin',
    'Encourage members to set up their community profile and join the people directory',
    'community_profile_setup',
    TRUE,
    5,  -- Minimal engagement required
    '{}',
    '{"community_profile_setup": "any"}',  -- Skip if already done
    E'{{user_name}} - We just launched the AgenticAdvertising.org community directory where members can discover and connect with each other.\n\nYou can set up your profile, list your expertise, and even flag yourself as open to coffee chats or introductions.\n\nCheck it out: https://agenticadvertising.org/community\n\nIt takes about 2 minutes to get set up. Want me to help you fill in any of the details?',
    E'The community directory is a way for members to find and connect with each other directly. You can browse other members, send connection requests, and discover people working on similar things. Your profile is only visible to other logged-in members.',
    80,  -- High priority -- community growth is important
    FALSE,  -- Disabled until community feature is announced
    'system'
  )
ON CONFLICT DO NOTHING;

-- Outcomes for "Join Community Directory"
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'sentiment', 'positive', 'success',
  'Great! Head to https://agenticadvertising.org/community to set up your profile. If you need any help, just ask.',
  'community_profile_setup', 'interested', 90
FROM outreach_goals g WHERE g.name = 'Join Community Directory';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, priority)
SELECT g.id, 'sentiment', 'negative', 'decline',
  'No worries at all. I''ll check back another time.',
  30, 80
FROM outreach_goals g WHERE g.name = 'Join Community Directory';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'timeout', '72', 'defer', 14, 50
FROM outreach_goals g WHERE g.name = 'Join Community Directory';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, priority)
SELECT g.id, 'default', NULL, 'defer',
  'No problem. The directory is at https://agenticadvertising.org/community whenever you''re ready.',
  10
FROM outreach_goals g WHERE g.name = 'Join Community Directory';

-- ============================================================================
-- GOAL 2: Complete community profile (for users who have a profile but it's sparse)
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, is_enabled, created_by)
VALUES
  (
    'Complete Community Profile',
    'admin',
    'Encourage members with incomplete community profiles to fill in more details',
    'community_profile_complete',
    TRUE,
    10,
    '{"community_profile_setup": "any"}',  -- Only for people who already started
    '{"community_profile_complete": "any"}',  -- Skip if already complete
    E'{{user_name}} - Your community profile is looking good! A few more details would help other members find and connect with you.\n\nThings like your expertise areas, a short bio, or flagging yourself as open to coffee chats make a big difference in getting relevant connections.\n\nWant me to help you update any of those?',
    E'More complete profiles get more connection requests. Members often search by expertise or location, so those fields are especially helpful.',
    60,
    FALSE,  -- Disabled until community feature is announced
    'system'
  )
ON CONFLICT DO NOTHING;

-- Outcomes for "Complete Community Profile"
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'sentiment', 'positive', 'success',
  'I can help right here! Just tell me your expertise areas, a short bio, or anything else you''d like to add, and I''ll update your profile.',
  'community_profile_complete', 'assisted', 90
FROM outreach_goals g WHERE g.name = 'Complete Community Profile';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, priority)
SELECT g.id, 'sentiment', 'negative', 'decline',
  'No worries. You can always update your profile at https://agenticadvertising.org/community whenever you like.',
  30, 80
FROM outreach_goals g WHERE g.name = 'Complete Community Profile';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'default', NULL, 'defer', 14, 10
FROM outreach_goals g WHERE g.name = 'Complete Community Profile';
