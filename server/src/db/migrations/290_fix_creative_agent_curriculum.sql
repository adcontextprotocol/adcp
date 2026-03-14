-- Fix curriculum content that treats "creative agent" as a distinct entity type
-- separate from sales agents. In reality, any agent implementing the Creative
-- Protocol is a creative agent — including sales agents that declare both
-- media_buy and creative in supported_protocols.

-- A2: Fix "Agent roles in action" to explain protocol composition
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Directing a media buy", "teaching_notes": "The learner tells Addie what they want: audience, goals, budget. Addie orchestrates the buy against @cptestagent. The learner is not coding — they are specifying intent. This is the fundamental interaction pattern of agentic advertising."},
    {"topic": "The transaction flow", "teaching_notes": "Walk through each step as it happens: get_products (discovery), create_media_buy (purchase), sync_creatives (creative), get_media_buy_delivery (measurement). Show the actual protocol messages. Each step is a distinct protocol task."},
    {"topic": "Agent roles in action", "teaching_notes": "Point out each agent''s role as the transaction unfolds. The buyer agent finds inventory. The sales agent responds with products and — if it implements the Creative Protocol — also handles creatives. A single sales agent often supports both media buy and creative tasks from one endpoint. A separate creative agent is possible but not required."},
    {"topic": "What just happened", "teaching_notes": "After the buy completes, step back and review: you just bought media through an AI agent using an open protocol. No DSP dashboard. No manual insertion orders. The same protocol would work with any AdCP-compliant seller."}
  ]'::jsonb
) WHERE id = 'A2';

-- B2: Add protocol composition and generative format context to creative format specs
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "get_products deep dive", "teaching_notes": "Walk through the get_products response schema in detail. Key fields: product name, description, format_types, targeting_options, pricing. Use sandbox demos to examine real responses. Reference the media buy task reference docs."},
    {"topic": "Creative format specifications", "teaching_notes": "Cover list_creative_formats — it returns exact specs for submitting creatives (dimensions, file types, max sizes, render requirements). A sales agent that declares creative in supported_protocols implements this task directly, so buyers discover formats from the same agent they buy from. For self-hosted generative formats, format_id.agent_url points to the sales agent itself. Reference the creative task reference docs and the sales agent creative capabilities guide (/docs/creative/sales-agent-creative-capabilities)."},
    {"topic": "Catalog optimization", "teaching_notes": "Discuss what makes a catalog AI-friendly: clear descriptions, logical grouping, complete targeting options, transparent pricing. Have the learner compare sandbox catalogs and suggest improvements."}
  ]'::jsonb
) WHERE id = 'B2';

-- C3: Rewrite creative lifecycle and cross-platform adaptation
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Creative lifecycle", "teaching_notes": "Walk through: build_creative → preview_creative → sync_creatives. Any agent implementing the Creative Protocol can handle these tasks — including sales agents that declare creative in supported_protocols. A sales agent with both protocols handles media buys and creatives from a single endpoint. Use sandbox demos. Reference creative protocol docs and the sales agent creative capabilities guide (/docs/creative/sales-agent-creative-capabilities)."},
    {"topic": "Cross-platform adaptation", "teaching_notes": "A single creative concept adapts for each publisher''s format requirements across display, video, audio, native. This happens on whichever agent implements the Creative Protocol — often the sales agent itself, especially for generative formats where the seller produces creatives at serve time from a brief. Discuss how this replaces manual resizing/reformatting while respecting both brand guidelines and publisher specs."},
    {"topic": "Sponsored Intelligence Protocol", "teaching_notes": "Cover SI as a distinct protocol for conversational AI placements. Brands participate in AI assistant experiences with transparency and user control. Reference the SI docs. Let the learner connect to a sandbox SI agent."}
  ]'::jsonb
) WHERE id = 'C3';

-- S2: Add protocol composition and brief-in-media-buy flow topics
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Format taxonomy", "teaching_notes": "19 channels, placement types, template formats with universal macros. The creative manifest specification: structured assets, typed asset groups, disclosure positions. Show how one creative adapts across display, video, audio, CTV, DOOH."},
    {"topic": "Protocol composition", "teaching_notes": "Any agent can implement the Creative Protocol by declaring creative in supported_protocols. Sales agents commonly do this to handle both media buys and creatives from a single endpoint. When format_id.agent_url points to the sales agent itself, the seller owns the format definition and generates creatives at serve time. Reference the sales agent creative capabilities guide (/docs/creative/sales-agent-creative-capabilities)."},
    {"topic": "AI-powered creative", "teaching_notes": "build_creative generates creatives from briefs. preview_creative shows the result before delivery. sync_creatives uploads to the platform. get_creative_delivery retrieves rendered output with pagination — callable on any agent implementing the Creative Protocol, including sales agents."},
    {"topic": "Brief-in-media-buy flow", "teaching_notes": "Buyers can submit creative briefs directly in create_media_buy. The seller generates creatives at serve time rather than requiring pre-built assets. The buyer reviews generated variants via get_creative_delivery on the same sales agent. This is how generative formats work: the buyer specifies intent, the seller''s creative capability handles production."},
    {"topic": "Compliance and disclosures", "teaching_notes": "Required disclosures with jurisdiction support (ISO 3166 country codes). Disclosure positions: prominent, footer, audio, subtitle, overlay, end_card. Prohibited claims. Formats declare supported_disclosure_positions. This is how regulatory compliance works at scale."},
    {"topic": "Creative features", "teaching_notes": "get_creative_features evaluates safety, quality, and categorization. Feature-based creative evaluation at scale — the Oracle model applied to creative content."}
  ]'::jsonb
) WHERE id = 'S2';
