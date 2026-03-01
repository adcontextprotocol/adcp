-- Migration: 255_founding_deadline_goal.sql
-- Time-sensitive outreach goal for the founding member enrollment deadline (March 31, 2026).
-- Addie uses this to notify non-members about locked founding pricing before it expires.

-- ============================================================================
-- GOAL: Founding Member Deadline
-- ============================================================================

INSERT INTO outreach_goals (
  name, category, description, success_insight_type,
  requires_mapped, requires_company_type, requires_min_engagement,
  requires_insights, excludes_insights,
  message_template, follow_up_template, follow_up_on_question,
  base_priority, max_attempts, days_between_attempts,
  is_enabled, created_by
)
VALUES (
  'Founding Member Deadline',
  'invitation',
  'Notify prospects of the March 31 founding member deadline and locked pricing',
  'membership_interest',
  FALSE,          -- Reach everyone, including unmapped users
  '{}',           -- Any company type
  0,              -- No engagement minimum
  '{}',           -- No required insights
  '{"membership_interest": "not_interested"}',  -- Skip users who already declined
  E'Hi {{user_name}} \u2014 quick heads-up on something time-sensitive. AgenticAdvertising.org is closing founding member enrollment on March 31. Founding members lock in current pricing permanently, regardless of future increases.\n\nIf your team works in ad tech, media, or AI-powered advertising, this is the last window to join at the founding rate. Happy to answer any questions about what membership includes.\n\n{{link_url}}',
  E'{{user_name}} \u2014 just a reminder that founding member enrollment closes March 31 ({{days_remaining}} days from now). After that, pricing increases for new members. Let me know if I can help your team get set up.\n\n{{link_url}}',
  E'Founding members get locked-in pricing that never increases, access to working groups and industry councils, the community directory, and a voice in shaping open standards for AI-powered advertising.',
  95,             -- Near-top priority
  2,              -- Two attempts: initial + one follow-up
  10,             -- 10-day gap between attempts
  TRUE,           -- Enabled immediately
  'system'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- OUTCOMES for Founding Member Deadline
-- ============================================================================

-- Positive response: record interest
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'sentiment', 'positive', 'success',
  NULL,  -- Let Addie respond naturally via the conversation handler
  'membership_interest', 'interested', 90
FROM outreach_goals g WHERE g.name = 'Founding Member Deadline';

-- Pricing question: clarify
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'intent', 'pricing_question', 'clarify',
  NULL,
  'membership_interest', 'pricing_question', 85
FROM outreach_goals g WHERE g.name = 'Founding Member Deadline';

-- Not now: defer 7 days
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, insight_to_record, insight_value, priority)
SELECT g.id, 'intent', 'not_now', 'defer',
  7,
  'membership_interest', 'deferred', 80
FROM outreach_goals g WHERE g.name = 'Founding Member Deadline';

-- Negative response: decline, record not interested
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, defer_days, priority)
SELECT g.id, 'sentiment', 'negative', 'decline',
  NULL,
  'membership_interest', 'not_interested', 90, 75
FROM outreach_goals g WHERE g.name = 'Founding Member Deadline';

-- Timeout (7 days, no response): defer
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'timeout', '168', 'defer', 10, 50
FROM outreach_goals g WHERE g.name = 'Founding Member Deadline';

-- Default fallback: defer
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'default', NULL, 'defer', 10, 10
FROM outreach_goals g WHERE g.name = 'Founding Member Deadline';
