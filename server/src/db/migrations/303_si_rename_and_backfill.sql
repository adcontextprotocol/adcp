-- Consolidate naming: "Sponsored Intelligence" is the umbrella for all AI media monetization.
-- "SI Chat Protocol" is the specific conversational creative format.
-- Also backfill credentials for users who completed modules but weren't awarded.

-- =====================================================
-- S5: Rename from "Generative Advertising" to "Sponsored Intelligence"
-- =====================================================

UPDATE certification_modules SET
  title = 'Sponsored Intelligence',
  description = 'Monetizing AI chat: generative creative from catalogs, the reversed data flow, SI Chat Protocol for conversational brand experiences, and account models for AI platforms and ad networks.',
  lesson_plan = '{
    "objectives": [
      "Build generative creative from brand assets and catalog data",
      "Execute Sponsored Intelligence campaigns using the reversed data flow",
      "Manage SI Chat Protocol sessions for conversational brand experiences",
      "Reason about when Sponsored Intelligence fits vs traditional approaches"
    ],
    "key_concepts": [
      {"topic": "Generative creative", "teaching_notes": "AI-powered creative generation via build_creative. The platform generates ads from brand assets (brand.json), product catalogs (sync_catalogs), and a natural language brief. Output modes: manifest (structured JSON) or code (dynamic creative). Format discovery via list_creative_formats. In Sponsored Intelligence, creative quality depends on input quality — richer brand data and catalogs produce better ads."},
      {"topic": "The reversed data flow", "teaching_notes": "Traditional programmatic sends bid requests OUT with thin signals. Sponsored Intelligence reverses this — buyers push catalogs, conversion events, brand identity, content standards, and optimization goals IN via AdCP. The platform''s LLM has full context to generate the right ad. Product types: sponsored responses (CPC/CPE), search results (CPC with keywords), generative display/video (CPM), brand experience handoffs via SI Chat Protocol."},
      {"topic": "Catalog-driven ad generation", "teaching_notes": "In Sponsored Intelligence, catalogs are the creative input. Product catalogs (sync_catalogs type: product) feed generative ad creation — titles, descriptions, prices, images. Offering catalogs (type: offering) enable commerce handoffs via SI Chat Protocol. The richer the catalog, the better the platform can match user intent to advertiser inventory."},
      {"topic": "SI Chat Protocol", "teaching_notes": "Conversational brand experiences in AI assistants. Four tasks: si_initiate_session, si_send_message, si_get_offering, si_terminate_session. The brand agent engages in a multi-turn conversation with product cards, carousels, and action buttons. Commerce handoff via ACP for checkout. SI Chat Protocol is the deepest form of Sponsored Intelligence — the entire experience is generated from brand data and conversation context."},
      {"topic": "Account models and governance", "teaching_notes": "Two seller shapes: first-party AI platforms (walled garden, require_operator_auth: true) and AI ad networks (implicit accounts, require_operator_auth: false). Generation-time governance: content standards become constraints on the LLM pipeline so unsuitable content is never produced. This is fundamentally stronger than post-hoc filtering."}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "s5_ex1",
      "title": "Sponsored Intelligence end-to-end",
      "description": "Build generative creative, execute a Sponsored Intelligence campaign, and explore SI Chat Protocol sessions.",
      "sandbox_actions": [
        {"tool": "list_creative_formats", "guidance": "Discover available generative creative formats."},
        {"tool": "build_creative", "guidance": "Generate a creative from brand assets and a brief."},
        {"tool": "sync_catalogs", "guidance": "Push a product catalog to an AI platform."},
        {"tool": "get_products", "guidance": "Discover Sponsored Intelligence products."},
        {"tool": "create_media_buy", "guidance": "Create a Sponsored Intelligence media buy with optimization goals."},
        {"tool": "si_initiate_session", "guidance": "Start an SI Chat Protocol brand conversation session."},
        {"tool": "si_send_message", "guidance": "Exchange messages in the brand conversation."}
      ],
      "success_criteria": [
        "Generates creative from brand assets and catalog data",
        "Understands the reversed data flow and can articulate why it matters",
        "Successfully syncs catalogs before creating a media buy",
        "Manages an SI Chat Protocol session lifecycle",
        "Can explain when Sponsored Intelligence fits vs traditional approaches"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "generative_creative", "weight": 25, "description": "Builds creative from brand assets, catalogs, and briefs", "scoring_guide": {"high": "Uses brand identity and catalog data to generate contextually relevant creative", "medium": "Can generate basic creative but misses brand/catalog integration", "low": "Cannot use the creative generation tools"}},
      {"name": "si_mastery", "weight": 30, "description": "Understands the reversed data flow and executes Sponsored Intelligence campaigns", "scoring_guide": {"high": "Articulates the paradigm shift, pushes full data pipeline, sets appropriate goals", "medium": "Can execute buys but cannot explain why SI differs from programmatic", "low": "Treats Sponsored Intelligence like traditional programmatic"}},
      {"name": "si_chat_competence", "weight": 25, "description": "Manages SI Chat Protocol sessions and understands conversational brand experiences", "scoring_guide": {"high": "Full session lifecycle with offering integration and commerce understanding", "medium": "Basic session flow without deeper understanding", "low": "Cannot complete a session"}},
      {"name": "strategic_thinking", "weight": 20, "description": "Reasons about when and how to use Sponsored Intelligence", "scoring_guide": {"high": "Can compare SI vs traditional approaches, understands economics", "medium": "Understands the basics", "low": "Cannot reason about strategic choices"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'S5';

-- Update S track description
UPDATE certification_tracks SET
  description = 'Protocol-specific deep dives with capstone assessment. Each covers a core AdCP protocol area: media buy, creative, signals, governance, or Sponsored Intelligence.'
WHERE id = 'S';

-- Update C track description
UPDATE certification_tracks SET
  description = 'Orchestrate multi-agent buying workflows. Brand identity protocols, creative workflows, and Sponsored Intelligence.'
WHERE id = 'C';

-- Update badge and credential names
UPDATE badges SET
  name = 'AdCP specialist — Sponsored Intelligence',
  description = 'Protocol specialist in Sponsored Intelligence: generative creative, reversed data flow, and SI Chat Protocol conversational brand experiences'
WHERE id = 'adcp_specialist_si';

UPDATE certification_credentials SET
  name = 'AdCP Specialist — Sponsored Intelligence',
  description = 'Protocol specialist in Sponsored Intelligence. Demonstrates mastery of generative creative, the reversed data flow, and SI Chat Protocol conversational brand experiences.'
WHERE id = 'specialist_si';

-- =====================================================
-- A1: Fix demo/exercise attribution clarity
-- Addie was hallucinating that learners shared get_products results
-- when it was Addie's own demo. Clarify the teaching flow.
-- =====================================================

UPDATE certification_modules SET
  lesson_plan = '{
    "objectives": [
      "Explain the difference between agentic and traditional programmatic advertising",
      "Understand AdCP covers 19 channels including linear TV, radio, print, and DOOH — not just digital",
      "Query a live agent and interpret the response",
      "Articulate why a shared protocol matters for AI-powered advertising"
    ],
    "key_concepts": [
      {"topic": "Agentic vs traditional programmatic", "teaching_notes": "Start with a demonstration: YOU call get_products against @cptestagent and show the learner the result. Walk through the response together. Then explain the paradigm shift — goal-driven agents vs rigid APIs. Let the protocol speak for itself before lecturing."},
      {"topic": "Not just digital", "teaching_notes": "AdCP covers 19 channels: display, social, search, CTV, linear TV, AM/FM radio, podcast, streaming audio, DOOH, OOH, print, cinema, email, gaming, retail media, influencer, affiliate, product placement, and Sponsored Intelligence. Can you buy local radio? Yes. Broadcast syndication? Yes. The same protocol buys a TikTok ad and a local news spot."},
      {"topic": "AI agents in advertising", "teaching_notes": "An agent perceives, decides, and acts autonomously. In advertising, agents discover inventory, negotiate pricing, manage creatives, and optimize campaigns. Reference YOUR earlier demo — the learner just saw an agent respond to a structured query."},
      {"topic": "The protocol hierarchy", "teaching_notes": "AdCP is built on MCP (Model Context Protocol). MCP handles transport. AdCP adds the advertising domain. Multiple transports work: MCP and A2A. Keep this brief — the point is that AdCP works across different connection methods."}
    ],
    "demo_scenarios": [
      {"description": "Query @cptestagent for available products", "tools": ["get_products"], "expected_outcome": "See products with pricing, targeting options, and format support — a real agent response, not a slide deck"}
    ]
  }'
WHERE id = 'A1';

-- =====================================================
-- CREDENTIAL BACKFILL
-- Award credentials to users who completed required modules but weren't awarded.
-- This handles users who completed certification before credential auto-award was working.
-- =====================================================

-- Basics: requires A1, A2, A3
INSERT INTO user_credentials (workos_user_id, credential_id)
SELECT DISTINCT lp.workos_user_id, 'basics'
FROM learner_progress lp
WHERE lp.status = 'completed'
  AND lp.module_id IN ('A1', 'A2', 'A3')
GROUP BY lp.workos_user_id
HAVING COUNT(DISTINCT lp.module_id) = 3
ON CONFLICT (workos_user_id, credential_id) DO NOTHING;

-- Practitioner: requires basics credential + at least one complete role track
-- Track B complete = B1,B2,B3,B4; Track C = C1,C2,C3,C4; Track D = D1,D2,D3,D4
INSERT INTO user_credentials (workos_user_id, credential_id)
SELECT DISTINCT uc.workos_user_id, 'practitioner'
FROM user_credentials uc
WHERE uc.credential_id = 'basics'
  AND (
    -- Track B complete
    (SELECT COUNT(DISTINCT module_id) FROM learner_progress
     WHERE workos_user_id = uc.workos_user_id AND status = 'completed'
       AND module_id IN ('B1','B2','B3','B4')) = 4
    OR
    -- Track C complete
    (SELECT COUNT(DISTINCT module_id) FROM learner_progress
     WHERE workos_user_id = uc.workos_user_id AND status = 'completed'
       AND module_id IN ('C1','C2','C3','C4')) = 4
    OR
    -- Track D complete
    (SELECT COUNT(DISTINCT module_id) FROM learner_progress
     WHERE workos_user_id = uc.workos_user_id AND status = 'completed'
       AND module_id IN ('D1','D2','D3','D4')) = 4
  )
ON CONFLICT (workos_user_id, credential_id) DO NOTHING;

-- Specialist credentials: require practitioner + specific S module
INSERT INTO user_credentials (workos_user_id, credential_id)
SELECT uc.workos_user_id, cc.id
FROM user_credentials uc
CROSS JOIN certification_credentials cc
WHERE uc.credential_id = 'practitioner'
  AND cc.requires_credential = 'practitioner'
  AND cc.id LIKE 'specialist_%'
  AND EXISTS (
    SELECT 1 FROM learner_progress lp
    WHERE lp.workos_user_id = uc.workos_user_id
      AND lp.status = 'completed'
      AND lp.module_id = ANY(cc.required_modules)
  )
ON CONFLICT (workos_user_id, credential_id) DO NOTHING;
