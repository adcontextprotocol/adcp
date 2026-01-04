-- ============================================================================
-- Migration: 130_strategic_insight_types.sql
-- Description: Add insight types for strategic engagement data collection
--
-- These insight types support strategic data collection during conversations.
-- When a member shares information during conversation (inbound or outbound),
-- it gets stored as a member_insight with the actual content of what they said.
-- ============================================================================

-- Strategic planning insights
INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES
  (
    'plans_2026',
    'Member plans for agentic advertising in 2026',
    ARRAY['Exploring buyer agents', 'Scaling measurement initiatives', 'Building internal agent capabilities', 'Waiting to see market direction'],
    TRUE,
    'system'
  ),
  (
    'membership_goals',
    'What the member wants from AgenticAdvertising.org membership',
    ARRAY['Networking and connections', 'Technical specifications', 'Staying informed', 'Finding partners', 'Learning best practices'],
    TRUE,
    'system'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

-- Feedback and challenges insights
INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES
  (
    'feedback',
    'Feedback on how AgenticAdvertising.org could improve',
    ARRAY['More hands-on workshops', 'Better documentation', 'More industry-specific content', 'Faster response times'],
    TRUE,
    'system'
  ),
  (
    'challenges',
    'Challenges the member is facing with agentic advertising',
    ARRAY['Measurement and attribution', 'Integration complexity', 'Internal buy-in', 'Budget constraints', 'Talent and skills'],
    TRUE,
    'system'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

-- Engagement and satisfaction insights
INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES
  (
    'satisfaction',
    'Overall satisfaction rating with AgenticAdvertising.org (1-10)',
    ARRAY['9-10 (high)', '7-8 (medium)', '5-6 (low)', '1-4 (very low)'],
    TRUE,
    'system'
  ),
  (
    'intro_interest',
    'Interest in being connected with other members',
    ARRAY['Wants introductions', 'Deferred for now', 'Not interested'],
    TRUE,
    'system'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

-- Additional useful insight types for natural conversation extraction
INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES
  (
    'use_case',
    'Specific use cases the member is working on',
    ARRAY['Programmatic buying', 'Creative optimization', 'Audience targeting', 'Campaign measurement', 'Brand safety'],
    TRUE,
    'system'
  ),
  (
    'timeline',
    'Timeline for implementing agentic advertising',
    ARRAY['Already live', 'Next quarter', 'This year', '2026', 'No specific timeline'],
    TRUE,
    'system'
  ),
  (
    'decision_role',
    'Role in decision-making for agentic advertising adoption',
    ARRAY['Decision maker', 'Influencer', 'Evaluator', 'End user', 'Observer'],
    TRUE,
    'system'
  ),
  (
    'competitors',
    'Competitive solutions being evaluated or used',
    ARRAY['Building in-house', 'Evaluating vendors', 'Using existing tools', 'No alternatives yet'],
    TRUE,
    'system'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

-- Create insight_goals entries that link to these insight types
-- These are for passive extraction during any conversation (different from outreach_goals)
-- Using ON CONFLICT to be idempotent
INSERT INTO insight_goals (
  name,
  question,
  insight_type_id,
  target_unmapped_only,
  target_mapped_only,
  priority,
  is_enabled
)
SELECT
  'Learn 2026 Plans',
  'What are you planning for agentic advertising in 2026?',
  id,
  FALSE,
  FALSE,  -- Works for both mapped and unmapped
  90,
  TRUE
FROM member_insight_types WHERE name = 'plans_2026'
ON CONFLICT DO NOTHING;

INSERT INTO insight_goals (
  name,
  question,
  insight_type_id,
  target_unmapped_only,
  target_mapped_only,
  priority,
  is_enabled
)
SELECT
  'Learn Membership Goals',
  'What are you hoping to get from your AgenticAdvertising.org membership?',
  id,
  FALSE,
  FALSE,
  85,
  TRUE
FROM member_insight_types WHERE name = 'membership_goals'
ON CONFLICT DO NOTHING;

INSERT INTO insight_goals (
  name,
  question,
  insight_type_id,
  target_unmapped_only,
  target_mapped_only,
  priority,
  is_enabled
)
SELECT
  'Learn Challenges',
  'What challenges are you facing with agentic advertising?',
  id,
  FALSE,
  FALSE,
  80,
  TRUE
FROM member_insight_types WHERE name = 'challenges'
ON CONFLICT DO NOTHING;

INSERT INTO insight_goals (
  name,
  question,
  insight_type_id,
  target_unmapped_only,
  target_mapped_only,
  priority,
  is_enabled
)
SELECT
  'Learn Use Cases',
  'What specific use cases are you focused on for agentic advertising?',
  id,
  FALSE,
  FALSE,
  85,
  TRUE
FROM member_insight_types WHERE name = 'use_case'
ON CONFLICT DO NOTHING;
