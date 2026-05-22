-- A2 module: use fictional brand domains in demo scenarios and exercises.
-- Sage was picking real member company domains (e.g. scope3.com) when generating
-- demo briefs because the lesson plan content gave no guidance on which brand to
-- use. Belt-and-suspenders reinforcement of the TEACHING RULES runtime rule added
-- in the same changeset (certification-tools.ts).

BEGIN;

-- 1. Replace key_concepts array to add fictional-domain note to "Directing a media buy".
UPDATE certification_modules
SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Directing a media buy", "teaching_notes": "The learner tells Addie what they want: audience, goals, budget. Addie orchestrates the buy against @cptestagent. The learner is not coding — they are specifying intent. This is the fundamental interaction pattern of agentic advertising. When you generate a sample brief to demonstrate, use a fictional brand domain (e.g. nova-brands.example or acme-corp.example) — never a real company domain."},
    {"topic": "The transaction flow", "teaching_notes": "Walk through each step as it happens: get_products (discovery), create_media_buy (purchase), sync_creatives (creative), get_media_buy_delivery (measurement). Show the actual protocol messages. Each step is a distinct protocol task."},
    {"topic": "Agent roles in action", "teaching_notes": "Point out each agent''s role as the transaction unfolds. The buyer agent finds inventory. The sales agent responds with products. The creative agent adapts assets. Multiple agents collaborate on one campaign."},
    {"topic": "What just happened", "teaching_notes": "After the buy completes, step back and review: you just bought media through an AI agent using an open protocol. No DSP dashboard. No manual insertion orders. The same protocol would work with any AdCP-compliant seller."}
  ]'::jsonb
)
WHERE id = 'A2';

-- 2. Replace demo_scenarios array to call out fictional domain in scenario description.
UPDATE certification_modules
SET lesson_plan = jsonb_set(
  lesson_plan,
  '{demo_scenarios}',
  '[{"description": "Execute a media buy against @cptestagent — use a fictional brand domain such as nova-brands.example in the brief", "tools": ["get_products", "create_media_buy", "sync_creatives", "get_media_buy_delivery"], "expected_outcome": "Complete a media buy lifecycle, see creatives synced and delivery metrics reported"}]'::jsonb
)
WHERE id = 'A2';

-- 3. Update a2_ex1 exercise description (element 0) to reinforce fictional domain use.
UPDATE certification_modules
SET exercise_definitions = jsonb_set(
  exercise_definitions,
  '{0,description}',
  '"Tell Addie about an audience you want to reach — use a fictional brand domain such as nova-brands.example — and watch a real media buy execute against @cptestagent."'::jsonb
)
WHERE id = 'A2';

COMMIT;
