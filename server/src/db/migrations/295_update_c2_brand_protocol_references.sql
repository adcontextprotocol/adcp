-- Fix stale C2 module references: "Brand Standards Protocol" → "Brand Protocol",
-- "/.well-known/adcp/brand.json" → "/.well-known/brand.json"

-- 1. Update description
UPDATE certification_modules SET
  description = 'The Brand Protocol (brand.json at /.well-known/brand.json), brand identity tasks (get_brand_identity, get_rights, acquire_rights), and how brand agents enforce guidelines and manage rights across automated buying.'
WHERE id = 'C2';

-- 2. Update lesson_plan key_concepts with teaching_notes
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Brand identity protocol", "teaching_notes": "Cover brand.json (at /.well-known/brand.json) — declares brand identity (house, names, logos, colors, tone, visual guidelines). Core identity is public by default. Authorized callers (linked via sync_accounts) get deeper data. Use the fields enum pattern and available_fields to show how callers discover what they can access. Reference the brand protocol docs and get_brand_identity task."},
    {"topic": "Brand protocol tasks", "teaching_notes": "Walk through the three brand tasks: get_brand_identity (identity with field selection), get_rights (rights discovery with pricing), acquire_rights (contractual clearance with generation credentials). For rights, use the Daan Janssen example — Dutch Olympic skater licensed through Loti Entertainment. Reference the task docs. Rejection handling. Rejections come in two forms: actionable (includes suggestions — different market, later date, different category) and final (no suggestions — move on to other talent). The presence or absence of the suggestions field is the signal. Demonstrate both patterns through the sandbox: have the learner trigger a final rejection (steakhouse campaign for Pieter van Dijk) and an actionable rejection (sportswear campaign for Daan Janssen). Relate to real-world brand management: agencies have confidential rules they cannot disclose."},
    {"topic": "Supply chain preferences", "teaching_notes": "Brands specify suitability (appropriate contexts), safety (must-avoid), and sustainability (environmental/social). These propagate through the buying chain. Have the learner design preferences for a hypothetical brand."}
  ]'::jsonb
) WHERE id = 'C2';

-- 3. Update lesson_plan objectives
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{objectives}',
  '[
    "Understand brand.json and how it establishes brand identity in AdCP",
    "Know the brand protocol tasks: get_brand_identity, get_rights, acquire_rights",
    "Understand public vs authorized brand data and the available_fields pattern",
    "Understand suitability, safety, and sustainability preferences"
  ]'::jsonb
) WHERE id = 'C2';

-- 4. Update lesson_plan discussion_prompts
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{discussion_prompts}',
  '[
    "Why is brand.json public by default? What would break if core identity required authentication?",
    "How does the available_fields pattern help buyer agents decide whether to link their account?",
    "What happens when a brand agent and a sales agent disagree on suitability?"
  ]'::jsonb
) WHERE id = 'C2';

-- 5. Update assessment_criteria scoring guide
UPDATE certification_modules SET assessment_criteria = '{
  "dimensions": [
    {"name": "conceptual_understanding", "weight": 30, "description": "Understands brand protocols", "scoring_guide": {"high": "Can explain brand.json, brand protocol tasks, and supply chain preferences in detail", "medium": "Understands brand.json but not how the task APIs work", "low": "Confuses brand identity with brand safety"}},
    {"name": "practical_knowledge", "weight": 25, "description": "Can configure brand compliance", "scoring_guide": {"high": "Designs a complete brand compliance setup with suitability, safety, and sustainability rules", "medium": "Can configure basic brand safety rules", "low": "Cannot configure brand compliance settings"}},
    {"name": "problem_solving", "weight": 20, "description": "Can resolve compliance conflicts", "scoring_guide": {"high": "Proposes resolution strategies when brand rules conflict with publisher inventory", "medium": "Identifies conflicts but struggles with resolution", "low": "Cannot identify or resolve compliance conflicts"}},
    {"name": "protocol_fluency", "weight": 25, "description": "Correct brand terminology", "scoring_guide": {"high": "Correctly uses brand.json, get_brand_identity, fields enum, available_fields, and brand protocol terms", "medium": "Mostly correct with minor terminology gaps", "low": "Confuses brand protocol concepts with general marketing terms"}}
  ],
  "passing_threshold": 70
}'::jsonb WHERE id = 'C2';
