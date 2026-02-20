-- Migration: 208_persona_group_affinity_seed.sql
-- Seed persona-council affinity scores based on JourneySpark appeal matrix (slide 6).
-- Uses ON CONFLICT for idempotency.

-- Helper: Insert affinity for a working group by slug
-- We use a CTE approach to look up IDs by slug

INSERT INTO persona_group_affinity (persona, working_group_id, affinity_score)
SELECT persona, wg.id, affinity_score
FROM (VALUES
  -- Technical Standards WG - Foundational Standards (data/privacy heavy)
  ('molecule_builder', 'technical-standards-wg', 3),
  ('data_decoder', 'technical-standards-wg', 5),
  ('pureblood_protector', 'technical-standards-wg', 4),
  ('resops_integrator', 'technical-standards-wg', 3),
  ('ladder_climber', 'technical-standards-wg', 2),
  ('simple_starter', 'technical-standards-wg', 2),

  -- Media Buying Protocol WG - broad appeal
  ('molecule_builder', 'media-buying-protocol-wg', 5),
  ('data_decoder', 'media-buying-protocol-wg', 4),
  ('pureblood_protector', 'media-buying-protocol-wg', 4),
  ('resops_integrator', 'media-buying-protocol-wg', 5),
  ('ladder_climber', 'media-buying-protocol-wg', 4),
  ('simple_starter', 'media-buying-protocol-wg', 3),

  -- Brand Standards WG - Policy/Governance (broad appeal)
  ('molecule_builder', 'brand-standards-wg', 5),
  ('data_decoder', 'brand-standards-wg', 5),
  ('pureblood_protector', 'brand-standards-wg', 5),
  ('resops_integrator', 'brand-standards-wg', 5),
  ('ladder_climber', 'brand-standards-wg', 4),
  ('simple_starter', 'brand-standards-wg', 3),

  -- Creative WG - broad appeal
  ('molecule_builder', 'creative-wg', 5),
  ('data_decoder', 'creative-wg', 4),
  ('pureblood_protector', 'creative-wg', 4),
  ('resops_integrator', 'creative-wg', 4),
  ('ladder_climber', 'creative-wg', 4),
  ('simple_starter', 'creative-wg', 3),

  -- Signals & Data WG - broad appeal, data-heavy
  ('molecule_builder', 'signals-data-wg', 4),
  ('data_decoder', 'signals-data-wg', 5),
  ('pureblood_protector', 'signals-data-wg', 4),
  ('resops_integrator', 'signals-data-wg', 4),
  ('ladder_climber', 'signals-data-wg', 3),
  ('simple_starter', 'signals-data-wg', 2),

  -- Training & Education WG - moderate appeal
  ('molecule_builder', 'training-education-wg', 3),
  ('data_decoder', 'training-education-wg', 3),
  ('pureblood_protector', 'training-education-wg', 3),
  ('resops_integrator', 'training-education-wg', 4),
  ('ladder_climber', 'training-education-wg', 4),
  ('simple_starter', 'training-education-wg', 5),

  -- Events & Thought Leadership WG - moderate appeal
  ('molecule_builder', 'events-thought-leadership-wg', 3),
  ('data_decoder', 'events-thought-leadership-wg', 3),
  ('pureblood_protector', 'events-thought-leadership-wg', 3),
  ('resops_integrator', 'events-thought-leadership-wg', 3),
  ('ladder_climber', 'events-thought-leadership-wg', 5),
  ('simple_starter', 'events-thought-leadership-wg', 4),

  -- Open Web Council - broad appeal
  ('molecule_builder', 'open-web-council', 4),
  ('data_decoder', 'open-web-council', 4),
  ('pureblood_protector', 'open-web-council', 4),
  ('resops_integrator', 'open-web-council', 4),
  ('ladder_climber', 'open-web-council', 3),
  ('simple_starter', 'open-web-council', 3),

  -- CTV Council (CTV & Streaming) - experience-focused
  ('molecule_builder', 'ctv-council', 4),
  ('data_decoder', 'ctv-council', 3),
  ('pureblood_protector', 'ctv-council', 3),
  ('resops_integrator', 'ctv-council', 4),
  ('ladder_climber', 'ctv-council', 2),
  ('simple_starter', 'ctv-council', 2),

  -- Retail Media Council - experience-focused
  ('molecule_builder', 'retail-media-council', 4),
  ('data_decoder', 'retail-media-council', 3),
  ('pureblood_protector', 'retail-media-council', 3),
  ('resops_integrator', 'retail-media-council', 4),
  ('ladder_climber', 'retail-media-council', 3),
  ('simple_starter', 'retail-media-council', 2),

  -- Policy Council - Governance (broad appeal)
  ('molecule_builder', 'policy-council', 5),
  ('data_decoder', 'policy-council', 5),
  ('pureblood_protector', 'policy-council', 5),
  ('resops_integrator', 'policy-council', 5),
  ('ladder_climber', 'policy-council', 4),
  ('simple_starter', 'policy-council', 3),

  -- Digital Audio Council - experience-focused
  ('molecule_builder', 'digital-audio-council', 4),
  ('data_decoder', 'digital-audio-council', 3),
  ('pureblood_protector', 'digital-audio-council', 3),
  ('resops_integrator', 'digital-audio-council', 4),
  ('ladder_climber', 'digital-audio-council', 2),
  ('simple_starter', 'digital-audio-council', 2),

  -- Creator Economy Council - customer-focused
  ('molecule_builder', 'creator-economy-council', 4),
  ('data_decoder', 'creator-economy-council', 3),
  ('pureblood_protector', 'creator-economy-council', 3),
  ('resops_integrator', 'creator-economy-council', 4),
  ('ladder_climber', 'creator-economy-council', 3),
  ('simple_starter', 'creator-economy-council', 2),

  -- AI Surfaces Council - experience-focused, innovation-heavy
  ('molecule_builder', 'ai-surfaces-council', 5),
  ('data_decoder', 'ai-surfaces-council', 4),
  ('pureblood_protector', 'ai-surfaces-council', 3),
  ('resops_integrator', 'ai-surfaces-council', 3),
  ('ladder_climber', 'ai-surfaces-council', 2),
  ('simple_starter', 'ai-surfaces-council', 2),

  -- OOH Council - experience-focused
  ('molecule_builder', 'ooh-council', 4),
  ('data_decoder', 'ooh-council', 3),
  ('pureblood_protector', 'ooh-council', 3),
  ('resops_integrator', 'ooh-council', 4),
  ('ladder_climber', 'ooh-council', 2),
  ('simple_starter', 'ooh-council', 2),

  -- Brand & Agency Council - customer-focused, broad appeal
  ('molecule_builder', 'brand-agency-council', 4),
  ('data_decoder', 'brand-agency-council', 3),
  ('pureblood_protector', 'brand-agency-council', 4),
  ('resops_integrator', 'brand-agency-council', 5),
  ('ladder_climber', 'brand-agency-council', 4),
  ('simple_starter', 'brand-agency-council', 3)
) AS v(persona, slug, affinity_score)
JOIN working_groups wg ON wg.slug = v.slug
ON CONFLICT (persona, working_group_id) DO UPDATE SET affinity_score = EXCLUDED.affinity_score;
