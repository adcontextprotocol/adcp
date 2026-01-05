-- ============================================================================
-- Migration: 129_engagement_goals.sql
-- Description: Add engagement-focused information gathering goals
--
-- Philosophy: These goals help us understand what members want to achieve
-- and how we can better serve them. They're about building relationships
-- and gathering strategic insights, not just onboarding.
-- ============================================================================

-- ============================================================================
-- STRATEGIC PLANNING GOALS
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Learn 2026 Plans',
    'information',
    'Understand member plans for agentic advertising in 2026',
    'plans_2026',
    TRUE,
    0,
    '{}',
    '{"plans_2026": "any"}',  -- Skip if we already know their plans
    E'{{user_name}} - I''m curious what {{company_name}} is thinking about for agentic advertising in 2026.\n\nAre you exploring any new initiatives? Scaling something that''s working? Or still figuring out where agents fit into your strategy?\n\nNo pressure - just trying to understand where members are headed so we can be more helpful.',
    E'I ask because it helps me connect you with the right people and resources. For example, if you''re focused on buyer agents, I can point you to members who''ve been doing interesting work there.',
    65,
    'system'
  ),
  (
    'Learn AAO Goals',
    'information',
    'Understand what members want from their AAO membership',
    'membership_goals',
    TRUE,
    10,  -- Some baseline engagement
    '{}',
    '{"membership_goals": "any"}',
    E'{{user_name}} - Quick question: what are you hoping to get out of AgenticAdvertising.org this year?\n\nSome members are here for the networking, others for the technical specs, others just want to stay informed. Everyone has different priorities.\n\nWhat matters most to you?',
    E'Understanding what you''re looking for helps me be more useful. I can prioritize certain types of updates, make introductions, or point you to resources you might not know about.',
    60,
    'system'
  );

-- ============================================================================
-- FEEDBACK GOALS
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Gather Feedback',
    'information',
    'Get feedback on how AAO could improve',
    'feedback',
    TRUE,
    20,  -- Want some engaged members
    '{}',
    '{"feedback": "recent"}',  -- Skip if we got feedback recently
    E'{{user_name}} - I''d love to hear your thoughts: is there anything you''d like to see AgenticAdvertising.org do more of? Or differently?\n\nWe''re always looking to improve. Could be events, content, working groups, Slack channels, whatever.\n\nWhat would make this more valuable for you?',
    E'This feedback goes directly to our team. We''ve made several changes based on member suggestions - like adding more hands-on workshops and creating industry-specific channels.',
    55,
    'system'
  ),
  (
    'Understand Challenges',
    'information',
    'Learn about challenges members are facing',
    'challenges',
    TRUE,
    15,
    '{}',
    '{"challenges": "recent"}',
    E'{{user_name}} - What''s the hardest part of agentic advertising for {{company_name}} right now?\n\nI hear a lot from members about measurement challenges, integration complexity, getting buy-in internally... curious what''s top of mind for you.\n\nMight be able to connect you with others who''ve tackled similar issues.',
    E'I ask because there''s a lot of collective knowledge in this community. Often someone else has solved - or is actively working on - whatever challenge you''re facing.',
    50,
    'system'
  );

-- ============================================================================
-- CONNECTION GOALS
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Offer Introductions',
    'connection',
    'Proactively offer to connect members with relevant peers',
    'intro_interest',
    TRUE,
    25,  -- Want reasonably engaged members
    '{}',
    '{"intro_declined": "recent"}',
    E'{{user_name}} - Is there anyone in the agentic advertising space you''d like to connect with?\n\nI can make introductions to other members - whether that''s potential partners, people solving similar problems, or folks at companies you admire.\n\nAnyone come to mind?',
    E'No commitment required - I''d just facilitate an intro if you''re interested. Many members tell us the connections have been the most valuable part of membership.',
    45,
    'system'
  ),
  (
    'Check Satisfaction',
    'information',
    'Gauge overall member satisfaction',
    'satisfaction',
    TRUE,
    30,  -- Established members
    '{}',
    '{"satisfaction": "recent"}',
    E'{{user_name}} - Quick pulse check: on a scale of 1-10, how valuable has AgenticAdvertising.org been for {{company_name}}?\n\nNo wrong answer - honest feedback helps us improve.\n\nAnd if there''s anything specific driving that number, I''d love to hear it.',
    E'This helps us understand what''s working and what isn''t. If you''re not getting value, that''s important to know so we can fix it.',
    40,
    'system'
  );

-- ============================================================================
-- OUTCOMES FOR ENGAGEMENT GOALS
-- ============================================================================

-- Learn 2026 Plans outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'intent', 'shares_plans', 'success',
  E'Thanks for sharing that - really helpful to understand where you''re headed. I''ll keep an eye out for relevant resources and people to connect you with.',
  'plans_2026', 'shared', 90
FROM outreach_goals g WHERE g.name = 'Learn 2026 Plans';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, priority)
SELECT g.id, 'intent', 'uncertain', 'clarify',
  E'Totally fair - lots of companies are still figuring this out. Even a general sense of where you''re leaning would be helpful, but no pressure.',
  NULL, 80
FROM outreach_goals g WHERE g.name = 'Learn 2026 Plans';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'sentiment', 'negative', 'decline', NULL, 70
FROM outreach_goals g WHERE g.name = 'Learn 2026 Plans';

-- Learn AAO Goals outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'network,connect,meet,introduction', 'success',
  E'Networking is a big part of what we do. I can help make specific introductions if you let me know what types of companies or roles would be most valuable.',
  'membership_goals', 'networking', 90
FROM outreach_goals g WHERE g.name = 'Learn AAO Goals';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'technical,spec,protocol,standard', 'success',
  E'The technical work is where a lot of the action is. The Technical Steering Committee and working groups are probably where you want to focus. Want me to get you connected?',
  'membership_goals', 'technical', 85
FROM outreach_goals g WHERE g.name = 'Learn AAO Goals';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'learn,informed,news,updates', 'success',
  E'Staying informed is totally valid. I''ll make sure you''re getting the right updates. Any specific topics you want to follow more closely?',
  'membership_goals', 'stay_informed', 80
FROM outreach_goals g WHERE g.name = 'Learn AAO Goals';

-- Gather Feedback outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'intent', 'provides_feedback', 'success',
  E'Really appreciate you sharing that. I''ll make sure the team sees this. Feedback like this is how we get better.',
  'feedback', 'provided', 90
FROM outreach_goals g WHERE g.name = 'Gather Feedback';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, priority)
SELECT g.id, 'intent', 'satisfied', 'success',
  E'Great to hear! If anything comes to mind later, feel free to reach out anytime.',
  NULL, 85
FROM outreach_goals g WHERE g.name = 'Gather Feedback';

-- Understand Challenges outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'measurement,attribution,roi,prove', 'success',
  E'Measurement is definitely a common challenge. Our Measurement Working Group is tackling this head-on. Want me to connect you?',
  'challenges', 'measurement', 90
FROM outreach_goals g WHERE g.name = 'Understand Challenges';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'integration,implement,technical,build', 'success',
  E'Integration complexity comes up a lot. The Technical Steering Committee has some good resources, and there are members who''ve been through similar implementations.',
  'challenges', 'integration', 85
FROM outreach_goals g WHERE g.name = 'Understand Challenges';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'buy-in,internal,stakeholder,executive,budget', 'success',
  E'Getting internal buy-in is tough. I can connect you with members who''ve successfully made the case internally - they might have useful perspectives.',
  'challenges', 'internal_buy_in', 80
FROM outreach_goals g WHERE g.name = 'Understand Challenges';

-- Offer Introductions outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'intent', 'interested', 'success',
  E'Great - let me know who or what type of company you''d like to connect with, and I''ll see what I can do.',
  'intro_interest', 'wants_intros', 90
FROM outreach_goals g WHERE g.name = 'Offer Introductions';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, insight_to_record, insight_value, priority)
SELECT g.id, 'intent', 'not_now', 'defer',
  E'No problem - the offer stands whenever you''re ready.',
  30, 'intro_interest', 'deferred', 80
FROM outreach_goals g WHERE g.name = 'Offer Introductions';

-- Check Satisfaction outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', '9,10,great,excellent,love,amazing', 'success',
  E'That''s great to hear! If you''re open to it, we''d love to feature {{company_name}} in a member spotlight or case study.',
  'satisfaction', 'high', 90
FROM outreach_goals g WHERE g.name = 'Check Satisfaction';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, next_goal_id, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', '1,2,3,4,5,6,low,not,disappointing', 'clarify',
  E'Thanks for being honest. What would make it more valuable? Specific things we could do better?',
  (SELECT id FROM outreach_goals WHERE name = 'Gather Feedback'),
  'satisfaction', 'low', 85
FROM outreach_goals g WHERE g.name = 'Check Satisfaction';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', '7,8,good,solid,fine,okay', 'success',
  E'Good to know. Anything specific that would bump that up to a 9 or 10?',
  'satisfaction', 'medium', 80
FROM outreach_goals g WHERE g.name = 'Check Satisfaction';

-- Default outcomes for all engagement goals
INSERT INTO goal_outcomes (goal_id, trigger_type, outcome_type, defer_days, priority)
SELECT g.id, 'timeout', 'defer', 14, 10
FROM outreach_goals g WHERE g.name IN (
  'Learn 2026 Plans', 'Learn AAO Goals', 'Gather Feedback',
  'Understand Challenges', 'Offer Introductions', 'Check Satisfaction'
);

INSERT INTO goal_outcomes (goal_id, trigger_type, outcome_type, priority)
SELECT g.id, 'default', 'clarify', 5
FROM outreach_goals g WHERE g.name IN (
  'Learn 2026 Plans', 'Learn AAO Goals', 'Gather Feedback',
  'Understand Challenges', 'Offer Introductions', 'Check Satisfaction'
);
