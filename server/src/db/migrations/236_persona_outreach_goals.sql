-- Migration: 210_persona_outreach_goals.sql
-- Add persona-based targeting to outreach goals and seed persona-specific goals.

-- Add requires_persona column to outreach_goals
ALTER TABLE outreach_goals ADD COLUMN IF NOT EXISTS requires_persona VARCHAR(50)[] DEFAULT '{}';

COMMENT ON COLUMN outreach_goals.requires_persona IS 'If non-empty, goal only applies to users whose org has one of these personas';

-- Seed persona-targeted outreach goals
INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_persona, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  -- Molecule Builder: Creative council invitation
  (
    'Invite Molecule Builder to Creative',
    'invitation',
    'Invite Molecule Builder personas to the Creative council where art meets science',
    'council_interest',
    TRUE,
    '{molecule_builder}',
    E'{{user_name}} - I noticed {{company_name}} works at the intersection of creativity and technology.\n\nOur Creative council brings together teams who combine art and science in advertising - exactly the kind of work you''re doing. They''re working on standards for AI-generated creative, dynamic optimization, and cross-channel experiences.\n\nWould you like to learn more about what they''re working on?',
    E'The Creative council meets monthly. Recent work includes guidelines for AI in creative production, frameworks for measuring creative effectiveness, and best practices for cross-platform creative optimization.',
    60,
    'system'
  ),

  -- Data Decoder: Signals & Data WG invitation
  (
    'Invite Data Decoder to Signals & Data',
    'invitation',
    'Invite Data Decoder personas to the Signals & Data working group',
    'council_interest',
    TRUE,
    '{data_decoder}',
    E'{{user_name}} - Given {{company_name}}''s focus on data and audience infrastructure, our Signals & Data working group might be a great fit.\n\nThis group works on identity signals, audience data standards, and measurement frameworks - the foundational data layer for agentic advertising.\n\nWould that be interesting to you?',
    E'The Signals & Data WG is tackling key challenges like post-cookie identity, first-party data interoperability, and AI-ready data standards. It''s where the data infrastructure decisions get made.',
    60,
    'system'
  ),

  -- Pureblood Protector: Brand Standards + Policy invitation
  (
    'Invite Pureblood Protector to Brand Standards',
    'invitation',
    'Invite Pureblood Protector personas to Brand Standards WG focused on clean advertising',
    'council_interest',
    TRUE,
    '{pureblood_protector}',
    E'{{user_name}} - I think {{company_name}} would find value in our Brand Standards working group.\n\nThis group focuses on brand safety, responsible advertising standards, and clean supply chain practices. Given your focus on quality and brand integrity, their work aligns well.\n\nInterested in hearing more?',
    E'Brand Standards WG works on supply path transparency, MFA site exclusion lists, and responsible advertising frameworks. They also collaborate with the Policy council on regulatory compliance.',
    60,
    'system'
  ),

  -- ResOps Integrator: Media Buying Protocol WG invitation
  (
    'Invite ResOps Integrator to Media Buying Protocol',
    'invitation',
    'Invite ResOps Integrator personas to the Media Buying Protocol WG',
    'council_interest',
    TRUE,
    '{resops_integrator}',
    E'{{user_name}} - Our Media Buying Protocol working group might be right up {{company_name}}''s alley.\n\nThis group is building the standards for how agents buy and optimize media across platforms - integrating products, services, and operations into a seamless workflow.\n\nWould you like to know more about the protocol work?',
    E'The Media Buying Protocol WG is developing AdCP - the Advertising Context Protocol. It defines how AI agents interact with ad platforms for media buying. If you''re integrating across products and services, this is where those standards are being set.',
    60,
    'system'
  ),

  -- Ladder Climber: Training & Education + Events invitation
  (
    'Invite Ladder Climber to Training & Events',
    'invitation',
    'Invite Ladder Climber personas to Training/Education WG and Events',
    'council_interest',
    TRUE,
    '{ladder_climber}',
    E'{{user_name}} - I wanted to share a couple of resources that could help {{company_name}} grow in the agentic advertising space.\n\nOur Training & Education working group creates practical guides and learning materials. And our Events & Thought Leadership group hosts sessions where you can learn directly from industry leaders.\n\nWould either of these be interesting?',
    E'Training & Education produces how-to guides, webinars, and certification materials. Events & Thought Leadership organizes conferences, panels, and networking sessions. Both are great for building expertise and connections.',
    55,
    'system'
  ),

  -- Simple Starter: Training & Education (gentle intro)
  (
    'Guide Simple Starter to Resources',
    'education',
    'Help Simple Starter personas discover educational resources',
    NULL,
    TRUE,
    '{simple_starter}',
    E'{{user_name}} - Welcome to AgenticAdvertising.org! I want to make sure you know about our educational resources.\n\nOur Training & Education working group puts together guides and materials specifically designed to help companies get started with agentic advertising.\n\nWould you like me to point you to some starter resources?',
    E'We have getting-started guides, recorded webinars, and a community of members who''ve been through the same learning curve. No pressure - just resources available when you need them.',
    50,
    'system'
  )
ON CONFLICT DO NOTHING;

-- Add default outcomes for new goals
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, insight_to_record, priority)
SELECT g.id, 'sentiment', 'positive', 'success', g.success_insight_type, 100
FROM outreach_goals g
WHERE g.requires_persona != '{}'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'sentiment' AND o.trigger_value = 'positive'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'intent', 'deferred', 'defer', 14, 80
FROM outreach_goals g
WHERE g.requires_persona != '{}'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'intent' AND o.trigger_value = 'deferred'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, priority)
SELECT g.id, 'sentiment', 'refusal', 'decline', 70
FROM outreach_goals g
WHERE g.requires_persona != '{}'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'sentiment' AND o.trigger_value = 'refusal'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'timeout', '168', 'defer', 14, 10
FROM outreach_goals g
WHERE g.requires_persona != '{}'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'timeout'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, priority)
SELECT g.id, 'default', NULL, 'escalate', 1
FROM outreach_goals g
WHERE g.requires_persona != '{}'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'default'
  );
