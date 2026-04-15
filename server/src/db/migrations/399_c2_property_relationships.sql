-- Add property relationships and bilateral verification to C2 (Brand identity and compliance protocols).
-- This extends C2 to cover how brand.json properties declare relationships (owned/direct/delegated/ad_network)
-- and how this creates bilateral verification with adagents.json delegation_type.

-- Add new learning objective
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{objectives}',
  (lesson_plan->'objectives') || '["Understand how brand.json properties declare relationships and create bilateral verification with adagents.json"]'::jsonb
) WHERE id = 'C2';

-- Add property relationships key concept
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (lesson_plan->'key_concepts') || '[
    {"topic": "Property relationships and bilateral verification", "explanation": "brand.json properties include a relationship field (owned, direct, delegated, ad_network) that matches adagents.json delegation_type. This creates bilateral verification: the operator declares the relationship in brand.json, and publishers confirm by authorizing the operator''s agents with matching delegation_type in their adagents.json. This is the AdCP equivalent of sellers.json + ads.txt."},
    {"topic": "Relationship types", "explanation": "owned = you operate this property (default). direct = you are the direct sales path. delegated = you manage monetization, you are in charge (e.g., Mediavine managing a food blog). ad_network = you sell as an exchange or SSP, you are a path, not the path (e.g., PubMatic as an SSP for nytimes.com)."}
  ]'::jsonb
) WHERE id = 'C2';

-- Add discussion prompt
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{discussion_prompts}',
  (lesson_plan->'discussion_prompts') || '["How does bilateral verification in AdCP compare to ads.txt + sellers.json? What problem does it solve that the legacy approach does not?"]'::jsonb
) WHERE id = 'C2';

-- Add teaching notes for the new concept
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN elem->>'topic' = 'Brand identity protocol'
        THEN jsonb_set(elem, '{teaching_notes}',
          to_jsonb(COALESCE(elem->>'teaching_notes', '') ||
            ' Also cover the properties array and the relationship field (owned/direct/delegated/ad_network). Explain that this creates bilateral verification with adagents.json — the operator declares their property portfolio, publishers confirm by authorizing the operator''s agents. Reference the ad networks docs for the full pattern.'
          ))
        ELSE elem
      END
    )
    FROM jsonb_array_elements(lesson_plan->'key_concepts') elem
  )
) WHERE id = 'C2' AND lesson_plan->'key_concepts' IS NOT NULL;
