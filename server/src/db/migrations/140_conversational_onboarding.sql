-- ============================================================================
-- Migration: 140_conversational_onboarding.sql
-- Description: Shift from survey-style questions to natural conversation
--
-- Philosophy: Instead of asking "What's your role?" or "What are your 2026 plans?",
-- we ask one casual opener and let the conversation flow naturally. Addie infers
-- the structured insights from what people share organically.
-- ============================================================================

-- ============================================================================
-- NEW INSIGHT TYPE: What brings them here
-- ============================================================================

INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES
  (
    'initial_interest',
    'What brought them to AgenticAdvertising.org - their opening statement',
    ARRAY[
      'Building a sales agent',
      'Exploring agentic advertising',
      'Sent by colleague/boss',
      'Saw news coverage',
      'Looking for technical specs',
      'Want to connect with others in the space'
    ],
    TRUE,
    'system'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

-- ============================================================================
-- NEW INSIGHT TYPE: Working solo or with team
-- ============================================================================

INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES
  (
    'team_context',
    'Whether they are driving this alone or working with others',
    ARRAY[
      'Solo/individual contributor',
      'Leading a team',
      'Part of a team',
      'Evaluating for leadership',
      'Cross-functional initiative'
    ],
    TRUE,
    'system'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

-- ============================================================================
-- NEW INSIGHT TYPE: Perspective preference
-- ============================================================================

INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES
  (
    'perspective_preference',
    'Whether they want business or technical perspective',
    ARRAY[
      'Technical/developer',
      'Business/strategy',
      'Both/hybrid',
      'Operations/execution'
    ],
    TRUE,
    'system'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

-- ============================================================================
-- UPDATE EXISTING OUTREACH GOAL: Make it conversational
-- ============================================================================

-- First, let's create a new conversational welcome goal (if it doesn't exist)
INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
SELECT
    'Welcome - What Brings You',
    'information',
    'Casual opener to understand what brought them here',
    'initial_interest',
    FALSE,  -- Works for unmapped users too
    0,
    '{}',
    '{"initial_interest": "any"}',  -- Skip if we already know
    E'Hey {{user_name}}! Glad you''re here.\n\nCurious - what brings you to AgenticAdvertising.org? Are you building something, exploring the space, or something else entirely?',
    E'No wrong answers - just helps me point you in the right direction.',
    95,  -- High priority for new users
    'system'
WHERE NOT EXISTS (
  SELECT 1 FROM outreach_goals WHERE name = 'Welcome - What Brings You'
);

-- Update if it already exists
UPDATE outreach_goals
SET description = 'Casual opener to understand what brought them here',
    message_template = E'Hey {{user_name}}! Glad you''re here.\n\nCurious - what brings you to AgenticAdvertising.org? Are you building something, exploring the space, or something else entirely?',
    follow_up_on_question = E'No wrong answers - just helps me point you in the right direction.',
    base_priority = 95
WHERE name = 'Welcome - What Brings You';

-- ============================================================================
-- OUTCOMES FOR WELCOME GOAL
-- These trigger contextual follow-ups based on what they share
-- ============================================================================

-- Building something specific
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'build,building,implement,ship,launch,deploy,agent,sales agent,buyer agent', 'success',
  E'Oh nice - you''re building something! Are you driving this yourself or working with a team? And are you looking for more of a technical deep-dive or the business angle?',
  'initial_interest', 'building', 90
FROM outreach_goals g WHERE g.name = 'Welcome - What Brings You'
AND NOT EXISTS (
  SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_value LIKE '%build%'
);

-- Exploring/learning
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'explore,exploring,curious,learn,learning,understand,figure out,check out', 'success',
  E'Makes sense - it''s a new space. Anything specific that sparked your interest? Or just getting a lay of the land?',
  'initial_interest', 'exploring', 85
FROM outreach_goals g WHERE g.name = 'Welcome - What Brings You'
AND NOT EXISTS (
  SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_value LIKE '%explore%'
);

-- Sent by someone
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'boss,manager,colleague,team,company,told,sent,asked', 'success',
  E'Got it - someone pointed you this way. Do you have a specific question they wanted answered, or more of a general "go figure out what this is about"?',
  'initial_interest', 'sent_by_others', 80
FROM outreach_goals g WHERE g.name = 'Welcome - What Brings You'
AND NOT EXISTS (
  SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_value LIKE '%boss%'
);

-- Looking for specs/technical
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'spec,specs,technical,protocol,api,documentation,docs,integrate,integration', 'success',
  E'Straight to the technical stuff - I like it. What are you trying to integrate with? I can point you to the right part of the docs.',
  'initial_interest', 'technical_specs', 85
FROM outreach_goals g WHERE g.name = 'Welcome - What Brings You'
AND NOT EXISTS (
  SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_value LIKE '%spec%'
);

-- Networking/connections
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'connect,network,meet,people,community,others,who else', 'success',
  E'The community is definitely a big part of what we do. Anyone specific you''re hoping to connect with? Or a type of company/role?',
  'initial_interest', 'networking', 80
FROM outreach_goals g WHERE g.name = 'Welcome - What Brings You'
AND NOT EXISTS (
  SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_value LIKE '%connect%'
);

-- Default/unclear
INSERT INTO goal_outcomes (goal_id, trigger_type, outcome_type, response_message, priority)
SELECT g.id, 'default', 'clarify',
  E'All good - we get all kinds here. Are you more on the technical side (building, integrating) or the business side (strategy, partnerships)?',
  50
FROM outreach_goals g WHERE g.name = 'Welcome - What Brings You'
AND NOT EXISTS (
  SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'default'
);

-- Timeout (168 hours = 7 days)
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'timeout', '168', 'defer', 7, 10
FROM outreach_goals g WHERE g.name = 'Welcome - What Brings You'
AND NOT EXISTS (
  SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'timeout'
);

-- ============================================================================
-- LOWER PRIORITY OF OLD SURVEY-STYLE GOALS
-- Keep them for passive extraction but don't proactively ask them
-- ============================================================================

UPDATE outreach_goals
SET base_priority = base_priority - 30,
    description = description || ' (passive extraction - don''t ask directly)'
WHERE name IN ('Learn 2026 Plans', 'Learn AAO Goals')
AND description NOT LIKE '%passive extraction%';

-- ============================================================================
-- ADD INSIGHT GOAL FOR PASSIVE EXTRACTION
-- Addie should infer these from natural conversation, not ask directly
-- ============================================================================

INSERT INTO insight_goals (
  name,
  question,
  insight_type_id,
  target_unmapped_only,
  target_mapped_only,
  priority,
  is_enabled,
  suggested_prompt_title,
  suggested_prompt_message
)
SELECT
  'Learn Initial Interest',
  'What brought you to AgenticAdvertising.org?',
  id,
  FALSE,
  FALSE,
  95,
  TRUE,
  'What brings you here?',
  'I''m curious what brought you to AgenticAdvertising.org'
FROM member_insight_types WHERE name = 'initial_interest'
AND NOT EXISTS (
  SELECT 1 FROM insight_goals WHERE name = 'Learn Initial Interest'
);
