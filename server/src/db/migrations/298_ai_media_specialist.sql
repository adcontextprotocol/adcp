-- Replace S5 (Sponsored Intelligence) with S5 (Generative Advertising)
-- Covers: generative creative, AI media surfaces, and Sponsored Intelligence

-- Update S5 module
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S5', 'S', 'Generative Advertising',
 'AI-generated ads across generative surfaces. Covers generative creative from catalogs, AI media buying (the reversed data flow), and Sponsored Intelligence conversational handoffs.',
 'capstone', 45, 5, false, '{A3}',
 '{
    "objectives": [
      "Build generative creative from brand assets and catalog data",
      "Execute AI media campaigns using the reversed data flow paradigm",
      "Manage Sponsored Intelligence sessions for conversational brand experiences",
      "Reason about when generative advertising fits vs traditional approaches"
    ],
    "key_concepts": [
      {"topic": "Generative creative", "teaching_notes": "AI-powered creative generation via build_creative. The platform generates ads from brand assets (brand.json), product catalogs (sync_catalogs), and a natural language brief. Output modes: manifest (structured JSON) or code (dynamic creative). Format discovery via list_creative_formats. The key insight: in generative advertising, creative quality depends on input quality — richer brand data and catalogs produce better ads."},
      {"topic": "AI media and the reversed data flow", "teaching_notes": "Traditional programmatic sends bid requests OUT with thin signals. AI media reverses this — buyers push catalogs, conversion events, brand identity, content standards, and optimization goals IN via AdCP. The platform''s LLM has full context to generate the right ad. The decision-maker is the context-holder. Product types: sponsored responses (CPC/CPE), AI search results (CPC with keywords), generative display/video (CPM), brand experience handoffs via SI."},
      {"topic": "Catalog-driven ad generation", "teaching_notes": "In AI media, catalogs are the creative input. Product catalogs (sync_catalogs type: product) feed generative ad creation — titles, descriptions, prices, images. Offering catalogs (type: offering) enable commerce handoffs via SI. The richer the catalog, the better the platform can match user intent to advertiser inventory."},
      {"topic": "Sponsored Intelligence", "teaching_notes": "Conversational brand experiences in AI assistants. Four tasks: si_initiate_session, si_send_message, si_get_offering, si_terminate_session. The brand agent engages in a multi-turn conversation with product cards, carousels, and action buttons. Commerce handoff via ACP for checkout. SI is the deepest form of generative advertising — the entire experience is generated from brand data and conversation context."},
      {"topic": "Account models and governance", "teaching_notes": "Two seller shapes for AI media: first-party platforms (walled garden, require_operator_auth: true) and ad networks (implicit accounts, require_operator_auth: false). Generation-time governance: content standards become constraints on the LLM pipeline so unsuitable content is never produced. This is fundamentally stronger than post-hoc filtering."}
    ]
  }',
 '[
    {
      "id": "s5_ex1",
      "title": "Generative advertising end-to-end",
      "description": "Build generative creative, execute an AI media campaign, and explore SI sessions.",
      "sandbox_actions": [
        {"tool": "list_creative_formats", "guidance": "Discover available generative creative formats."},
        {"tool": "build_creative", "guidance": "Generate a creative from brand assets and a brief."},
        {"tool": "sync_catalogs", "guidance": "Push a product catalog to an AI platform."},
        {"tool": "get_products", "guidance": "Discover AI media products with channels: [ai_media]."},
        {"tool": "create_media_buy", "guidance": "Create an AI media buy with optimization goals."},
        {"tool": "si_initiate_session", "guidance": "Start a brand conversation session."},
        {"tool": "si_send_message", "guidance": "Exchange messages in the brand conversation."}
      ],
      "success_criteria": [
        "Generates creative from brand assets and catalog data",
        "Understands the reversed data flow and can articulate why it matters",
        "Successfully syncs catalogs before creating an AI media buy",
        "Manages an SI session lifecycle",
        "Can explain when generative advertising fits vs traditional approaches"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "generative_creative", "weight": 25, "description": "Builds creative from brand assets, catalogs, and briefs", "scoring_guide": {"high": "Uses brand identity and catalog data to generate contextually relevant creative", "medium": "Can generate basic creative but misses brand/catalog integration", "low": "Cannot use the creative generation tools"}},
      {"name": "ai_media_mastery", "weight": 30, "description": "Understands the reversed data flow and executes AI media campaigns", "scoring_guide": {"high": "Articulates the paradigm shift, pushes full data pipeline, sets appropriate goals", "medium": "Can execute buys but cannot explain why AI media differs from programmatic", "low": "Treats AI media like traditional programmatic"}},
      {"name": "si_competence", "weight": 25, "description": "Manages SI sessions and understands conversational brand experiences", "scoring_guide": {"high": "Full session lifecycle with offering integration and commerce understanding", "medium": "Basic session flow without deeper understanding", "low": "Cannot complete a session"}},
      {"name": "strategic_thinking", "weight": 20, "description": "Reasons about when and how to use generative advertising", "scoring_guide": {"high": "Can compare generative vs traditional approaches, understands economics", "medium": "Understands the basics", "low": "Cannot reason about strategic choices"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria;

-- Update badge
INSERT INTO badges (id, name, description, icon, category) VALUES
  ('adcp_specialist_si', 'AdCP specialist — Generative Advertising', 'Protocol specialist in generative creative, AI media surfaces, and Sponsored Intelligence conversational brand experiences', 'specialist', 'certification')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- Update credential
UPDATE certification_credentials SET
  name = 'AdCP Specialist — Generative Advertising',
  description = 'Protocol specialist in generative advertising. Demonstrates mastery of AI-generated creative, AI media buying, and Sponsored Intelligence conversational handoffs.'
WHERE id = 'specialist_si';
