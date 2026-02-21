-- Migration: 237_add_pragmatic_builder_persona.sql
-- Promote bootstrapper assessment archetype to a first-class persona.
-- Bootstrappers are cross-functional generalists who score high on experimentation,
-- first-party data, and test-and-learn culture but don't spike into any specialist persona.

-- =====================================================
-- 1. UPDATE CHECK CONSTRAINTS TO ALLOW NEW VALUE
-- =====================================================

-- organizations.persona
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_persona_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_persona_check
  CHECK (persona IS NULL OR persona IN (
    'molecule_builder', 'data_decoder', 'pureblood_protector',
    'resops_integrator', 'ladder_climber', 'simple_starter', 'pragmatic_builder'
  ));

-- organizations.aspiration_persona
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_aspiration_persona_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_aspiration_persona_check
  CHECK (aspiration_persona IS NULL OR aspiration_persona IN (
    'molecule_builder', 'data_decoder', 'pureblood_protector',
    'resops_integrator', 'ladder_climber', 'simple_starter', 'pragmatic_builder'
  ));

-- persona_group_affinity.persona
ALTER TABLE persona_group_affinity DROP CONSTRAINT IF EXISTS persona_group_affinity_persona_check;
ALTER TABLE persona_group_affinity ADD CONSTRAINT persona_group_affinity_persona_check
  CHECK (persona IN (
    'molecule_builder', 'data_decoder', 'pureblood_protector',
    'resops_integrator', 'ladder_climber', 'simple_starter', 'pragmatic_builder'
  ));

-- =====================================================
-- 2. UPDATE ORG_KNOWLEDGE_ATTRIBUTES ENUM VALUES
-- =====================================================

UPDATE org_knowledge_attributes
SET valid_values = ARRAY[
  'molecule_builder', 'data_decoder', 'pureblood_protector',
  'resops_integrator', 'ladder_climber', 'simple_starter', 'pragmatic_builder'
]
WHERE name IN ('persona', 'aspiration_persona');

-- =====================================================
-- 3. SEED AFFINITY SCORES
-- =====================================================
-- Pragmatic Builders are generalists who experiment broadly.
-- They score moderate-to-high across practical working groups
-- and moderate on channel-specific councils.

INSERT INTO persona_group_affinity (persona, working_group_id, affinity_score)
SELECT persona, wg.id, affinity_score
FROM (VALUES
  ('pragmatic_builder', 'technical-standards-wg', 3),
  ('pragmatic_builder', 'media-buying-protocol-wg', 4),
  ('pragmatic_builder', 'brand-standards-wg', 4),
  ('pragmatic_builder', 'creative-wg', 4),
  ('pragmatic_builder', 'signals-data-wg', 4),
  ('pragmatic_builder', 'training-education-wg', 3),
  ('pragmatic_builder', 'events-thought-leadership-wg', 3),
  ('pragmatic_builder', 'open-web-council', 4),
  ('pragmatic_builder', 'ctv-council', 3),
  ('pragmatic_builder', 'retail-media-council', 3),
  ('pragmatic_builder', 'policy-council', 3),
  ('pragmatic_builder', 'digital-audio-council', 3),
  ('pragmatic_builder', 'creator-economy-council', 3),
  ('pragmatic_builder', 'ai-surfaces-council', 3),
  ('pragmatic_builder', 'ooh-council', 3),
  ('pragmatic_builder', 'brand-agency-council', 4)
) AS v(persona, slug, affinity_score)
JOIN working_groups wg ON wg.slug = v.slug
ON CONFLICT (persona, working_group_id) DO UPDATE SET affinity_score = EXCLUDED.affinity_score;

-- =====================================================
-- 4. SEED OUTREACH GOAL
-- =====================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_persona, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Invite Pragmatic Builder to Media Buying & Creative',
    'invitation',
    'Invite Pragmatic Builder personas to Media Buying Protocol and Creative working groups',
    'council_interest',
    TRUE,
    '{pragmatic_builder}',
    E'{{user_name}} - Your breadth at {{company_name}} is exactly what our working groups need.\n\nOur Media Buying Protocol group is building the standards for how agents buy media across platforms, and our Creative group is working on AI-driven creative optimization. Both benefit from generalists who see the full picture.\n\nWould either of these be a good fit?',
    E'Media Buying Protocol is developing AdCP - the open standard for agentic media buying. Creative WG focuses on AI in creative production and cross-channel optimization. Both groups value practical, cross-functional perspectives.',
    55,
    'system'
  );

-- =====================================================
-- 5. SEED GOAL OUTCOMES
-- =====================================================

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, insight_to_record, priority)
SELECT g.id, 'sentiment', 'positive', 'success', g.success_insight_type, 100
FROM outreach_goals g
WHERE g.name = 'Invite Pragmatic Builder to Media Buying & Creative'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'sentiment' AND o.trigger_value = 'positive'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'intent', 'deferred', 'defer', 14, 80
FROM outreach_goals g
WHERE g.name = 'Invite Pragmatic Builder to Media Buying & Creative'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'intent' AND o.trigger_value = 'deferred'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, priority)
SELECT g.id, 'sentiment', 'refusal', 'decline', 70
FROM outreach_goals g
WHERE g.name = 'Invite Pragmatic Builder to Media Buying & Creative'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'sentiment' AND o.trigger_value = 'refusal'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'timeout', '168', 'defer', 14, 10
FROM outreach_goals g
WHERE g.name = 'Invite Pragmatic Builder to Media Buying & Creative'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'timeout'
  );

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, priority)
SELECT g.id, 'default', NULL, 'escalate', 1
FROM outreach_goals g
WHERE g.name = 'Invite Pragmatic Builder to Media Buying & Creative'
  AND NOT EXISTS (
    SELECT 1 FROM goal_outcomes o WHERE o.goal_id = g.id AND o.trigger_type = 'default'
  );
