-- Curriculum revision: expand from 14 to 22 modules
-- - Rename Basics → Explorer (credential ID stays 'basics' for data stability)
-- - Add new modules: A4, A5, B4, C4, D4, S1-S5
-- - Restructure A1-A3 for hands-on focus (A3 becomes catalogs, old A3 → A5)
-- - Replace E track capstones with S track specialists
-- - Add build projects (B4, C4, D4) as practitioner gates
-- - Add Sponsored Intelligence specialist (S5)

-- =====================================================
-- TRACK UPDATES
-- =====================================================

-- Add specialist track (replaces E)
INSERT INTO certification_tracks (id, name, description, badge_type, certifier_group_id, sort_order) VALUES
  ('S', 'Specialist deep dives', 'Protocol-specific deep dives with capstone assessment. Each covers a core AdCP protocol area in depth: media buy, creative, signals, governance, or sponsored intelligence.', NULL, NULL, 6)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  badge_type = EXCLUDED.badge_type,
  sort_order = EXCLUDED.sort_order;

-- Update existing track descriptions
UPDATE certification_tracks SET
  description = 'Required for all learners. Hands-on from minute one: query live agents, run a real media buy, explore product catalogs, and understand how money flows in agentic advertising.'
WHERE id = 'A';

UPDATE certification_tracks SET
  description = 'Build and operate an AdCP sales agent. Product catalog design, creative specifications, measurement, and a hands-on build project.'
WHERE id = 'B';

UPDATE certification_tracks SET
  description = 'Build a buying agent that orchestrates multi-agent workflows. Brand identity, creative workflows, compliance, and a hands-on build project.'
WHERE id = 'C';

UPDATE certification_tracks SET
  description = 'Build AdCP infrastructure. MCP server architecture, supply path and agent trust, RTB migration patterns, and a hands-on build project.'
WHERE id = 'D';

-- =====================================================
-- MODULE UPDATES — Track A (revised foundations)
-- =====================================================

-- A1: Renamed and restructured for hands-on
UPDATE certification_modules SET
  title = 'Your first agent conversation',
  description = 'Query live sales agents across channels — digital, CTV, radio, DOOH. See real AdCP responses. Understand what agents are and why AdCP matters.',
  duration_minutes = 15,
  lesson_plan = '{
    "objectives": [
      "Query a live sales agent and interpret the response",
      "Explain the difference between agentic and traditional programmatic advertising",
      "Understand AdCP covers 19 channels including linear TV, radio, print, and DOOH — not just digital",
      "Articulate why a shared protocol matters for AI-powered advertising"
    ],
    "key_concepts": [
      {"topic": "Agentic vs traditional programmatic", "teaching_notes": "Start hands-on: have the learner query a sandbox sales agent immediately. After they see a real response, explain the paradigm shift — goal-driven agents vs rigid APIs. Let the protocol speak for itself before lecturing."},
      {"topic": "This is not just digital", "teaching_notes": "AdCP covers 19 channels: display, social, search, CTV, linear TV, AM/FM radio, podcast, DOOH, OOH, print, cinema, gaming, retail media, influencer, affiliate, product placement. Have the learner query agents across different channels — a digital publisher, a CTV seller, a radio broadcaster. The same protocol buys a TikTok ad and a local news spot. Amazon already has an MCP service for their DSP."},
      {"topic": "AI agents in advertising", "teaching_notes": "An agent perceives, decides, and acts autonomously. In advertising, agents discover inventory, negotiate pricing, manage creatives, and optimize campaigns. Use the live agent interaction to ground this — the learner just talked to an agent."},
      {"topic": "The protocol hierarchy", "teaching_notes": "AdCP is built on MCP (Model Context Protocol). MCP handles transport. AdCP adds the advertising domain. Multiple transports work: MCP and A2A. Keep this brief — the point is that AdCP works across different connection methods."}
    ],
    "demo_scenarios": [
      {"description": "Query a sandbox digital publisher", "tools": ["get_products"], "expected_outcome": "See display and video products with CPM pricing"},
      {"description": "Query a sandbox CTV seller", "tools": ["get_products"], "expected_outcome": "See CTV products with different targeting options"},
      {"description": "Query a sandbox radio broadcaster", "tools": ["get_products"], "expected_outcome": "See radio products with GRP-based planning — same protocol, different channel"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "a1_ex1",
      "title": "Cross-channel discovery",
      "description": "Query sandbox sales agents across three different channels and compare their product catalogs.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Query a digital publisher, a CTV seller, and a radio broadcaster. Notice the protocol is identical — only the products differ."}
      ],
      "success_criteria": [
        "Successfully queries agents across at least 2 different channels",
        "Can identify channel-specific differences in the product catalogs (e.g., CPM vs GRP pricing)",
        "Understands that the same protocol works across all channels"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "conceptual_understanding", "weight": 25, "description": "Understands agentic vs traditional paradigm", "scoring_guide": {"high": "Can articulate the shift from APIs to agents with concrete examples", "medium": "Understands the difference but misses nuances", "low": "Confuses agents with traditional APIs"}},
      {"name": "practical_knowledge", "weight": 35, "description": "Can use the protocol and interpret responses", "scoring_guide": {"high": "Successfully queries agents, interprets responses, identifies channel differences", "medium": "Can query but struggles with interpretation", "low": "Cannot complete basic agent queries"}},
      {"name": "channel_breadth", "weight": 20, "description": "Understands AdCP is not just digital", "scoring_guide": {"high": "Can name multiple non-digital channels and explain how they work in AdCP", "medium": "Knows AdCP covers more than digital", "low": "Thinks AdCP is only for programmatic display"}},
      {"name": "protocol_fluency", "weight": 20, "description": "Uses AdCP terminology correctly", "scoring_guide": {"high": "Correctly uses terms like MCP, agent, get_products, channel", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A1';

-- A2: Renamed to "Your first media buy"
UPDATE certification_modules SET
  title = 'Your first media buy',
  description = 'Addie runs a real media buy for you against sandbox agents. Describe your audience and goals — watch agents discover inventory, execute the buy, sync creatives, and report delivery.',
  duration_minutes = 20,
  lesson_plan = '{
    "objectives": [
      "Direct Addie to execute a real media buy against sandbox agents",
      "Trace the full transaction flow: discovery → selection → purchase → creative → measurement",
      "Understand agent roles: buyer, seller, creative, signals agents working together",
      "See cross-channel buying in action — digital and broadcast in one transaction"
    ],
    "key_concepts": [
      {"topic": "Directing a media buy", "teaching_notes": "The learner tells Addie what they want: audience, goals, budget. Addie orchestrates the buy. The learner is not coding — they are specifying intent. This is the fundamental interaction pattern of agentic advertising."},
      {"topic": "The transaction flow", "teaching_notes": "Walk through each step as it happens: get_products (discovery), create_media_buy (purchase), sync_creatives (creative), get_media_buy_delivery (measurement). Show the actual protocol messages. DSPs are just another sales agent — Amazon DSP already exposes an MCP service."},
      {"topic": "Agent roles in action", "teaching_notes": "Point out each agent''s role as the transaction unfolds. The buyer agent finds inventory. The sales agent responds with products. The creative agent adapts assets. The signals agent reports results. Multiple agents collaborate on one campaign."},
      {"topic": "Cross-channel execution", "teaching_notes": "Execute a buy that spans channels — digital display + a radio spot. Same protocol, same workflow. Show how GRP-based planning for broadcast sits alongside impression-based digital. The agent handles the differences."}
    ],
    "demo_scenarios": [
      {"description": "Execute a cross-channel media buy", "tools": ["get_products", "create_media_buy", "sync_creatives", "get_media_buy_delivery"], "expected_outcome": "Complete a media buy across digital and broadcast channels, see creatives synced and delivery metrics reported"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "a2_ex1",
      "title": "Your first buy",
      "description": "Tell Addie about an audience you want to reach and watch a real media buy execute against sandbox agents.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Addie discovers available inventory from multiple sellers."},
        {"tool": "create_media_buy", "guidance": "Addie executes the buy based on the learner''s brief."},
        {"tool": "get_media_buy_delivery", "guidance": "Addie shows delivery metrics after the buy is placed."}
      ],
      "success_criteria": [
        "Successfully directs a media buy by describing target audience and goals",
        "Can identify each step of the transaction flow as it happens",
        "Understands that the same workflow works across channels"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "conceptual_understanding", "weight": 25, "description": "Understands the transaction flow and agent roles", "scoring_guide": {"high": "Can describe each step and which agent handles it", "medium": "Gets main steps right but misses details", "low": "Cannot trace the transaction flow"}},
      {"name": "practical_knowledge", "weight": 35, "description": "Can direct a media buy and interpret results", "scoring_guide": {"high": "Successfully directs a buy and understands the delivery report", "medium": "Can direct but struggles interpreting results", "low": "Cannot complete a media buy"}},
      {"name": "problem_solving", "weight": 15, "description": "Can reason about what happens when things go wrong", "scoring_guide": {"high": "Identifies failure points and asks good questions", "medium": "Identifies some issues", "low": "Cannot reason about failures"}},
      {"name": "protocol_fluency", "weight": 25, "description": "Uses correct task names and agent roles", "scoring_guide": {"high": "Names tasks and roles correctly", "medium": "Mostly correct", "low": "Frequently misnames things"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A2';

-- A3: Complete rewrite — now "Product data and catalogs" (old A3 content moves to A5)
UPDATE certification_modules SET
  title = 'Product data and catalogs',
  description = 'The feed conversation every marketer has: how do I get my products into agentic advertising? 13 catalog types, feed field mappings, store catchments — this is how PMAX works in the agentic world.',
  duration_minutes = 20,
  lesson_plan = '{
    "objectives": [
      "Understand the 13 catalog types and when to use each",
      "Explain how feed field mappings normalize product data without preprocessing",
      "Describe how catalogs connect to creative formats through field bindings",
      "Use sync_catalogs to upload product data to a sandbox agent"
    ],
    "key_concepts": [
      {"topic": "Catalog types", "teaching_notes": "13 types: product, store, promotion, hotel, flight, job, vehicle, real_estate, education, destination, app, inventory, offering. Each has a vertical-specific schema. Use the travel advertiser example — hotel catalogs have star_rating, amenities, nightly pricing. Job catalogs have employment_type, salary ranges. This maps directly to what marketers already do with Google Merchant Center and Meta catalogs."},
      {"topic": "Feed formats and field mappings", "teaching_notes": "AdCP accepts feeds from Google Merchant Center, Facebook Catalog, Shopify, LinkedIn Jobs, or custom formats. Feed field mappings let you normalize without preprocessing — rename fields, transform dates, convert cents to dollars, split comma-separated strings, map images to asset pools. Show a concrete example: hotel_name → name, price_cents → price.amount with divide transform."},
      {"topic": "Catalog-to-creative connection", "teaching_notes": "Formats declare what catalog data they need through catalog_requirements — which catalog type, required fields, item count constraints. Field bindings connect format slots to catalog fields: the headline comes from the product name, the hero image comes from the landscape image pool. This is how dynamic creative works in AdCP."},
      {"topic": "Store catalogs and catchment areas", "teaching_notes": "Store catalogs include physical locations with lat/lng, addresses, operating hours. Catchment areas define reach: 15-minute drive (isochrone), 5km radius, or custom GeoJSON boundaries. This enables location-based targeting — reach customers near your stores. Show how store_catchments in targeting references synced store locations."},
      {"topic": "Item-level approval", "teaching_notes": "Just like Google Merchant Center, platforms review catalog items. sync_catalogs returns per-item status: approved, pending, rejected with reasons. Show the approval workflow and how to handle rejections."}
    ],
    "demo_scenarios": [
      {"description": "Explore catalog requirements on a creative format", "tools": ["list_creative_formats"], "expected_outcome": "See what catalog data a product carousel format requires"},
      {"description": "Sync a small product catalog", "tools": ["sync_catalogs"], "expected_outcome": "Upload product data and see item-level approval status"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "a3_ex1",
      "title": "Your first catalog sync",
      "description": "Explore what catalog data a creative format needs, then sync a small product catalog to a sandbox agent.",
      "sandbox_actions": [
        {"tool": "list_creative_formats", "guidance": "Check catalog_requirements on a dynamic product format. What fields are required?"},
        {"tool": "sync_catalogs", "guidance": "Sync a small product catalog with at least 3 items. See the approval status."}
      ],
      "success_criteria": [
        "Can identify what catalog data a format requires",
        "Successfully syncs a catalog and interprets the approval response",
        "Understands the relationship between catalogs and creatives"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "conceptual_understanding", "weight": 25, "description": "Understands catalog types and their purpose", "scoring_guide": {"high": "Can name catalog types and explain when to use each", "medium": "Knows the main types", "low": "Confused about catalog taxonomy"}},
      {"name": "practical_knowledge", "weight": 35, "description": "Can sync catalogs and interpret results", "scoring_guide": {"high": "Successfully syncs data and handles approvals", "medium": "Can sync but struggles with field mappings", "low": "Cannot complete a catalog sync"}},
      {"name": "feed_literacy", "weight": 20, "description": "Understands feed normalization and field mappings", "scoring_guide": {"high": "Can design field mappings for a real feed", "medium": "Understands the concept", "low": "Cannot explain field mappings"}},
      {"name": "protocol_fluency", "weight": 20, "description": "Uses correct catalog terminology", "scoring_guide": {"high": "Correctly uses catalog types, field bindings, catchments", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A3';

-- A4: New module — Accounts, brands, and billing
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('A4', 'A', 'Accounts, brands, and billing',
 'How money flows in agentic advertising. Accounts protocol, billing models, brand identity through brand.json, agent discovery, and capability negotiation.',
 'interactive', 20, 4, false, '{A3}',
 '{
    "objectives": [
      "Explain how accounts establish billing relationships between agents and sellers",
      "Distinguish operator-billed from agent-billed models",
      "Describe brand.json and how brands authorize agencies to act on their behalf",
      "Use get_adcp_capabilities to discover what a seller supports"
    ],
    "key_concepts": [
      {"topic": "Accounts protocol", "teaching_notes": "sync_accounts is how an agent declares: I represent this brand, through this agency, with this billing model. The seller provisions an account and returns a status. Walk through the three account examples: direct advertiser, agency with client, agent consolidating billing. This is the commercial infrastructure that makes buying possible."},
      {"topic": "Billing models", "teaching_notes": "Operator-billed: the agency or brand gets invoiced directly. Agent-billed: the agent consolidates billing across all its clients. This matters for agencies — agent billing lets them manage cash flow across their portfolio. Use a concrete example: an agency buying across 10 brands wants one consolidated invoice, not 10."},
      {"topic": "Brand identity — brand.json", "teaching_notes": "Hosted at /.well-known/brand.json. Contains brand portfolio, authorized operators, logos, colors, tone of voice, product catalogs. Four variants: house portfolio (P&G with many brands), brand agent (dynamic via MCP), house redirect (points to parent), authoritative location redirect (points to canonical URL). The key insight: authorized_operators controls who can buy on behalf of the brand."},
      {"topic": "Agent discovery", "teaching_notes": "adagents.json is like robots.txt for agents — publishers declare which agents can access their inventory. get_adcp_capabilities replaces static agent cards with runtime negotiation — the seller tells you what targeting, reporting, and features they support. Show a real capabilities response."},
      {"topic": "Account lifecycle", "teaching_notes": "Accounts move through states: active → payment_required → suspended → closed. Some sellers require approval (pending_approval with a setup URL). Credit limits and payment terms matter. Show the full lifecycle with a concrete example."}
    ],
    "demo_scenarios": [
      {"description": "Set up an account with a sandbox seller", "tools": ["sync_accounts"], "expected_outcome": "See account provisioned with status and billing details"},
      {"description": "Discover seller capabilities", "tools": ["get_adcp_capabilities"], "expected_outcome": "See what targeting, reporting, and features a seller supports"}
    ]
  }',
 '[
    {
      "id": "a4_ex1",
      "title": "Account setup and capability discovery",
      "description": "Set up a billing account with a sandbox seller and discover their capabilities.",
      "sandbox_actions": [
        {"tool": "sync_accounts", "guidance": "Establish a billing account for a fictional brand through an agency."},
        {"tool": "get_adcp_capabilities", "guidance": "Discover what the seller supports — targeting, reporting dimensions, pricing models."}
      ],
      "success_criteria": [
        "Successfully sets up an account and interprets the response",
        "Can explain the difference between operator-billed and agent-billed",
        "Can read a capabilities response and identify what the seller supports"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "conceptual_understanding", "weight": 30, "description": "Understands accounts, billing, and brand identity", "scoring_guide": {"high": "Can explain billing models and brand authorization", "medium": "Understands the basics", "low": "Confused about how money flows"}},
      {"name": "practical_knowledge", "weight": 30, "description": "Can set up accounts and discover capabilities", "scoring_guide": {"high": "Successfully sets up accounts and interprets capabilities", "medium": "Can do it with guidance", "low": "Cannot complete account setup"}},
      {"name": "problem_solving", "weight": 15, "description": "Can reason about real-world scenarios", "scoring_guide": {"high": "Can design account structure for a multi-brand agency", "medium": "Handles simple scenarios", "low": "Cannot apply concepts"}},
      {"name": "protocol_fluency", "weight": 25, "description": "Uses correct account and brand terminology", "scoring_guide": {"high": "Correctly uses billing models, brand.json, authorized_operators", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  format = EXCLUDED.format,
  duration_minutes = EXCLUDED.duration_minutes,
  sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free,
  prerequisites = EXCLUDED.prerequisites,
  lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions,
  assessment_criteria = EXCLUDED.assessment_criteria;

-- A5: New module — The ecosystem (old A3 governance content)
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('A5', 'A', 'The ecosystem',
 'How AgenticAdvertising.org works: working groups, industry councils, the spec development process. How AdCP relates to OpenRTB, IAB standards, and how to participate.',
 'interactive', 15, 5, false, '{A4}',
 '{
    "objectives": [
      "Describe AgenticAdvertising.org governance structure",
      "Understand how the specification is developed and versioned",
      "Explain AdCP''s relationship to existing ad tech standards",
      "Know how to participate in the ecosystem"
    ],
    "key_concepts": [
      {"topic": "Governance structure", "teaching_notes": "Member-driven organization with working groups (Signals, Creative, Governance, etc.) and industry councils. The spec evolves through RFCs and community consensus. Show the actual working group structure."},
      {"topic": "Specification development", "teaching_notes": "Semantic versioning: patch (fixes), minor (new features), major (breaking changes). Changes go through proposal → working group → community feedback → ratification. Open-source and transparent."},
      {"topic": "Relationship to existing standards", "teaching_notes": "AdCP complements OpenRTB, not replaces it. OpenRTB handles real-time bidding; AdCP handles agent workflows. They coexist — AdCP agents can generate RTB bid requests. AdCP builds on IAB standards for taxonomy, viewability, measurement."},
      {"topic": "Participation paths", "teaching_notes": "Join a working group, attend industry councils, build agents, contribute to open source. Show the actual paths available — this should feel actionable, not abstract."}
    ]
  }',
 NULL,
 '{
    "dimensions": [
      {"name": "conceptual_understanding", "weight": 30, "description": "Understands governance and spec process", "scoring_guide": {"high": "Accurately describes the process", "medium": "General understanding", "low": "Confused about governance"}},
      {"name": "practical_knowledge", "weight": 30, "description": "Knows how to participate", "scoring_guide": {"high": "Can describe specific participation paths", "medium": "Knows some paths", "low": "Unclear on how to participate"}},
      {"name": "communication_clarity", "weight": 15, "description": "Can explain the ecosystem clearly", "scoring_guide": {"high": "Clear and organized", "medium": "Mostly clear", "low": "Disorganized"}},
      {"name": "protocol_fluency", "weight": 25, "description": "Understands AdCP relationship to other standards", "scoring_guide": {"high": "Accurately describes relationships", "medium": "Gets the general idea", "low": "Confuses standards"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  format = EXCLUDED.format,
  duration_minutes = EXCLUDED.duration_minutes,
  sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free,
  prerequisites = EXCLUDED.prerequisites,
  lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions,
  assessment_criteria = EXCLUDED.assessment_criteria;

-- =====================================================
-- BUILD PROJECT MODULES — B4, C4, D4
-- =====================================================

-- B4: Publisher build project
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('B4', 'B', 'Build project — your first sales agent',
 'Create a working sales agent that responds to real buyer queries. Starter template provided. Any AI coding assistant welcome — the skill tested is specifying correct AdCP behavior.',
 'capstone', 45, 4, false, '{B3}',
 '{
    "objectives": [
      "Create a working MCP server that implements AdCP sales agent tasks",
      "Handle get_products, create_media_buy, and list_creative_formats correctly",
      "Return proper error responses for invalid requests",
      "Explain design decisions and how to extend the agent"
    ],
    "key_concepts": [
      {"topic": "Build project structure", "teaching_notes": "Provide a starter template that is ~60% complete — MCP server scaffold with AdCP tool definitions stubbed out. The learner fills in the product catalog, pricing, format support, and buy handling. Any AI coding assistant is welcome. The skill is specifying correct AdCP behavior, not writing TypeScript."},
      {"topic": "Schema compliance", "teaching_notes": "Responses must validate against AdCP JSON schemas. Run automated test queries against the learner''s agent. Show specific failures with schema paths when validation fails."},
      {"topic": "Error handling", "teaching_notes": "This is where async patterns and error recovery emerge naturally. The agent must handle invalid requests gracefully — return proper AdCP error responses with recovery hints (transient, correctable, terminal). Introduce idempotency keys for create_media_buy."},
      {"topic": "Cross-role interaction", "teaching_notes": "The build project must handle incoming requests from a buyer agent. The learner''s sales agent receives get_products queries and create_media_buy requests from sandbox buyer agents. This forces understanding of the other side of the protocol."}
    ]
  }',
 '[
    {
      "id": "b4_ex1",
      "title": "Build and test your sales agent",
      "description": "Using the starter template, create a sales agent with at least 3 products and 2 creative formats. Addie will test it with real buyer queries.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Addie queries the learner''s agent and validates the response schema."},
        {"tool": "create_media_buy", "guidance": "Addie sends a media buy request and checks the response."},
        {"tool": "list_creative_formats", "guidance": "Addie queries creative format support."}
      ],
      "success_criteria": [
        "Agent responds to get_products with valid schema-compliant output",
        "Agent handles create_media_buy requests correctly",
        "Agent returns proper error responses for invalid requests",
        "Learner can explain design decisions"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "schema_compliance", "weight": 30, "description": "Responses validate against AdCP schemas", "scoring_guide": {"high": "All responses pass schema validation", "medium": "Most responses valid with minor issues", "low": "Responses fail schema validation"}},
      {"name": "completeness", "weight": 25, "description": "Implements required tasks", "scoring_guide": {"high": "All 3 required tasks implemented correctly", "medium": "2 of 3 tasks working", "low": "Only 1 task or none working"}},
      {"name": "error_handling", "weight": 20, "description": "Graceful degradation with proper error responses", "scoring_guide": {"high": "Returns proper AdCP errors for invalid requests", "medium": "Handles some error cases", "low": "Crashes on invalid input"}},
      {"name": "design_rationale", "weight": 25, "description": "Can explain decisions in conversation", "scoring_guide": {"high": "Clear rationale for product catalog design and format choices", "medium": "Can explain basics", "low": "Cannot articulate design decisions"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  format = EXCLUDED.format,
  duration_minutes = EXCLUDED.duration_minutes,
  sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free,
  prerequisites = EXCLUDED.prerequisites,
  lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions,
  assessment_criteria = EXCLUDED.assessment_criteria;

-- C4: Buyer build project
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('C4', 'C', 'Build project — your first buyer agent',
 'Create a working buyer agent that discovers products, executes media buys, and syncs creatives against sandbox sales agents. Starter template provided.',
 'capstone', 45, 4, false, '{C3}',
 '{
    "objectives": [
      "Create an agent that discovers products from multiple sellers",
      "Execute media buys with targeting and budget constraints",
      "Sync creatives across formats",
      "Monitor campaign delivery"
    ],
    "key_concepts": [
      {"topic": "Buyer orchestration", "teaching_notes": "The buyer agent must query multiple sandbox sales agents, compare products, and execute buys. Provide a starter template with the orchestration scaffold — learner configures product selection logic, targeting, budget allocation, and creative sync."},
      {"topic": "Async patterns", "teaching_notes": "create_media_buy may return async responses (working/submitted status). The learner''s agent must handle these — poll or wait for completion. This is where async patterns emerge naturally from building."},
      {"topic": "Error handling in buying", "teaching_notes": "Sandbox agents will return errors: BUDGET_TOO_LOW, PRODUCT_UNAVAILABLE, CREATIVE_REJECTED. The buyer agent must handle these gracefully — retry, adjust, or report to the user."},
      {"topic": "Cross-role interaction", "teaching_notes": "The buyer agent must actually purchase from sandbox sales agents. This forces understanding of both sides of every transaction."}
    ]
  }',
 '[
    {
      "id": "c4_ex1",
      "title": "Build and test your buyer agent",
      "description": "Using the starter template, create a buyer agent that discovers products from at least 2 sellers and executes a media buy with creative sync.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Agent discovers products from multiple sandbox sellers."},
        {"tool": "create_media_buy", "guidance": "Agent executes a buy with targeting and budget."},
        {"tool": "sync_creatives", "guidance": "Agent syncs creatives to the purchased inventory."}
      ],
      "success_criteria": [
        "Agent discovers products from at least 2 sandbox sellers",
        "Agent executes a valid media buy with targeting",
        "Agent syncs at least 1 creative",
        "Learner can explain orchestration decisions"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "schema_compliance", "weight": 30, "description": "Requests validate against AdCP schemas", "scoring_guide": {"high": "All requests pass schema validation", "medium": "Most requests valid", "low": "Requests fail validation"}},
      {"name": "completeness", "weight": 25, "description": "Implements discovery, buying, and creative sync", "scoring_guide": {"high": "Full workflow from discovery to creative sync", "medium": "Discovery and buying but no creative", "low": "Only discovery working"}},
      {"name": "error_handling", "weight": 20, "description": "Handles seller errors gracefully", "scoring_guide": {"high": "Handles async responses and error codes", "medium": "Handles some cases", "low": "Breaks on unexpected responses"}},
      {"name": "design_rationale", "weight": 25, "description": "Can explain orchestration decisions", "scoring_guide": {"high": "Clear rationale for product selection and budget allocation", "medium": "Can explain basics", "low": "Cannot articulate decisions"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  format = EXCLUDED.format,
  duration_minutes = EXCLUDED.duration_minutes,
  sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free,
  prerequisites = EXCLUDED.prerequisites,
  lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions,
  assessment_criteria = EXCLUDED.assessment_criteria;

-- D4: Platform build project
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('D4', 'D', 'Build project — AdCP infrastructure',
 'Build a working AdCP endpoint that handles real protocol flows. Either a publisher-side MCP server or an intermediary that proxies between buyer and seller agents.',
 'capstone', 45, 4, false, '{D3}',
 '{
    "objectives": [
      "Build a working AdCP MCP server or intermediary",
      "Handle the full protocol flow: discovery, buying, delivery",
      "Implement proper error handling and async patterns",
      "Configure agent discovery via capabilities"
    ],
    "key_concepts": [
      {"topic": "Platform build options", "teaching_notes": "Two paths: (1) publisher-side MCP server handling get_products, create_media_buy, delivery — or (2) intermediary proxying between buyer and seller agents. Both require full protocol implementation. Provide starter templates for both options."},
      {"topic": "Full protocol implementation", "teaching_notes": "This is the most ambitious build project. The endpoint must handle the complete task set for its role. Async patterns, error recovery, idempotency keys, and webhook delivery are required — not optional."},
      {"topic": "Capability advertisement", "teaching_notes": "The endpoint must implement get_adcp_capabilities to advertise what it supports. This is how other agents discover the platform''s features."},
      {"topic": "Infrastructure concerns", "teaching_notes": "OAuth 2.0 setup, rate limiting, logging, monitoring. These emerge naturally from building real infrastructure. The starter template scaffolds these — the learner configures and extends."}
    ]
  }',
 '[
    {
      "id": "d4_ex1",
      "title": "Build and test your AdCP endpoint",
      "description": "Using a starter template, build a working AdCP endpoint. Addie will test it with real protocol flows.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "Addie discovers the endpoint''s capabilities."},
        {"tool": "get_products", "guidance": "Addie queries for products (if publisher-side)."},
        {"tool": "create_media_buy", "guidance": "Addie sends a media buy request."}
      ],
      "success_criteria": [
        "Endpoint responds to capability discovery",
        "Handles at least 3 AdCP tasks correctly",
        "Returns proper error responses",
        "Learner can explain architecture decisions"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "schema_compliance", "weight": 30, "description": "Protocol compliance across all endpoints", "scoring_guide": {"high": "All responses pass schema validation", "medium": "Most responses valid", "low": "Schema violations"}},
      {"name": "completeness", "weight": 25, "description": "Handles the required protocol flows", "scoring_guide": {"high": "Full flow from discovery to delivery", "medium": "Partial flow", "low": "Only basic endpoints"}},
      {"name": "error_handling", "weight": 20, "description": "Proper error handling with recovery types", "scoring_guide": {"high": "Full async patterns and error recovery", "medium": "Basic error handling", "low": "Crashes on errors"}},
      {"name": "design_rationale", "weight": 25, "description": "Can explain architecture decisions", "scoring_guide": {"high": "Clear architecture rationale", "medium": "Can explain basics", "low": "Cannot articulate decisions"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  format = EXCLUDED.format,
  duration_minutes = EXCLUDED.duration_minutes,
  sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free,
  prerequisites = EXCLUDED.prerequisites,
  lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions,
  assessment_criteria = EXCLUDED.assessment_criteria;

-- =====================================================
-- SPECIALIST MODULES — Track S (replaces E1-E4, adds S5)
-- =====================================================

-- Move E1-E4 to S1-S4 (delete from E, insert to S)
-- First, migrate any existing learner_progress from E→S module IDs
UPDATE learner_progress SET module_id = 'S1' WHERE module_id = 'E1';
UPDATE learner_progress SET module_id = 'S2' WHERE module_id = 'E2';
UPDATE learner_progress SET module_id = 'S3' WHERE module_id = 'E3';
UPDATE learner_progress SET module_id = 'S4' WHERE module_id = 'E4';

-- Delete old E modules (S versions will be inserted below)
DELETE FROM certification_modules WHERE id IN ('E1', 'E2', 'E3', 'E4');

-- S1: Media buy mastery
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S1', 'S', 'Media buy mastery',
 'Full media buy lifecycle across all tasks. Proposals, delivery forecasting, refinement, package management, optimization goals, keyword targeting, and geo-proximity.',
 'capstone', 45, 1, false, '{A5}',
 '{
    "objectives": [
      "Master the complete media buy lifecycle including proposals and forecasting",
      "Use refinement protocol for campaign modifications",
      "Configure advanced targeting: keywords, geo-proximity, store catchments",
      "Analyze delivery reports with dimension breakdowns"
    ],
    "key_concepts": [
      {"topic": "Proposals and forecasting", "teaching_notes": "Pre-flight budget allocation across products. Delivery forecasts with budget points and metric ranges. Three forecast methods: estimate, modeled, guaranteed. GRP-based planning for TV/radio alongside impression-based digital."},
      {"topic": "Refinement protocol", "teaching_notes": "Typed change requests with scope. The seller responds with refinement_applied to confirm what was changed. This handles the negotiation between buyer and seller after initial buy."},
      {"topic": "Advanced targeting", "teaching_notes": "Keyword targeting with match types and per-keyword bids. Geo-proximity with isochrones (15-min drive) and radius targeting. Store catchments referencing synced store locations. Demographic systems for TV/radio (GRP-based)."},
      {"topic": "Delivery analysis", "teaching_notes": "Opt-in reporting_dimensions for breakdowns: by_geo, by_device_type, by_keyword, by_catalog_item, by_package. Dimension arrays with truncation flags. Sort capability declarations."}
    ]
  }',
 '[
    {
      "id": "s1_ex1",
      "title": "Complex multi-product buy with refinement",
      "description": "Execute a multi-product media buy, refine it based on delivery data, and analyze results across dimensions.",
      "sandbox_actions": [
        {"tool": "create_media_buy", "guidance": "Execute a buy across multiple products with advanced targeting."},
        {"tool": "update_media_buy", "guidance": "Refine the buy based on initial delivery metrics."},
        {"tool": "get_media_buy_delivery", "guidance": "Analyze delivery with dimension breakdowns."}
      ],
      "success_criteria": [
        "Executes a multi-product buy with keyword and geo targeting",
        "Successfully refines the buy using the refinement protocol",
        "Analyzes delivery data across multiple dimensions",
        "Demonstrates understanding of proposals and forecasting"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "protocol_mastery", "weight": 30, "description": "Comprehensive understanding of media buy lifecycle", "scoring_guide": {"high": "Can execute the full lifecycle including proposals, refinement, and delivery analysis", "medium": "Handles basic buying but struggles with advanced features", "low": "Cannot complete a full lifecycle"}},
      {"name": "targeting_expertise", "weight": 25, "description": "Masters advanced targeting capabilities", "scoring_guide": {"high": "Configures keyword, geo-proximity, and catchment targeting correctly", "medium": "Handles basic targeting", "low": "Cannot configure advanced targeting"}},
      {"name": "analytical_skill", "weight": 25, "description": "Analyzes delivery data effectively", "scoring_guide": {"high": "Uses dimension breakdowns to derive actionable insights", "medium": "Can read delivery reports", "low": "Cannot interpret delivery data"}},
      {"name": "problem_solving", "weight": 20, "description": "Handles complex scenarios and edge cases", "scoring_guide": {"high": "Navigates async responses, budget constraints, and refinement negotiations", "medium": "Handles some complexity", "low": "Struggles with real-world scenarios"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria;

-- S2: Creative mastery
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S2', 'S', 'Creative mastery',
 'Full creative protocol from format design through compliance. 19 channels, creative manifest, AI-powered generation, disclosure requirements, and creative feature evaluation.',
 'capstone', 45, 2, false, '{A5}',
 '{
    "objectives": [
      "Master the complete creative protocol across all channels",
      "Build creatives using AI-powered generation",
      "Configure compliance and disclosure requirements",
      "Evaluate creative features for safety and quality"
    ],
    "key_concepts": [
      {"topic": "Format taxonomy", "teaching_notes": "19 channels, placement types, template formats with universal macros. The creative manifest specification: structured assets, typed asset groups, disclosure positions. Show how one creative adapts across display, video, audio, CTV, DOOH."},
      {"topic": "AI-powered creative", "teaching_notes": "build_creative generates creatives from briefs. preview_creative shows the result before delivery. sync_creatives uploads to the platform. get_creative_delivery retrieves rendered output with pagination."},
      {"topic": "Compliance and disclosures", "teaching_notes": "Required disclosures with jurisdiction support (ISO 3166 country codes). Disclosure positions: prominent, footer, audio, subtitle, overlay, end_card. Prohibited claims. Formats declare supported_disclosure_positions. This is how regulatory compliance works at scale."},
      {"topic": "Creative features", "teaching_notes": "get_creative_features evaluates safety, quality, and categorization. Feature-based creative evaluation at scale — the Oracle model applied to creative content."}
    ]
  }',
 '[
    {
      "id": "s2_ex1",
      "title": "Multi-format creative production pipeline",
      "description": "Build a creative, preview it, sync across formats, and evaluate features.",
      "sandbox_actions": [
        {"tool": "build_creative", "guidance": "Generate a creative from a brief."},
        {"tool": "preview_creative", "guidance": "Preview the generated creative."},
        {"tool": "sync_creatives", "guidance": "Sync across multiple formats."},
        {"tool": "get_creative_features", "guidance": "Evaluate the creative for safety and quality."}
      ],
      "success_criteria": [
        "Successfully builds a creative from a brief",
        "Previews and syncs across at least 2 formats",
        "Configures disclosure requirements for a jurisdiction",
        "Evaluates creative features and interprets results"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "protocol_mastery", "weight": 30, "description": "Complete creative lifecycle mastery", "scoring_guide": {"high": "Full pipeline from brief to delivery with compliance", "medium": "Basic creative workflow", "low": "Cannot complete the pipeline"}},
      {"name": "cross_platform", "weight": 25, "description": "Adapts creatives across channels and formats", "scoring_guide": {"high": "Successfully adapts across 3+ formats/channels", "medium": "Handles 1-2 formats", "low": "Single-format only"}},
      {"name": "compliance", "weight": 25, "description": "Configures disclosures and regulatory requirements", "scoring_guide": {"high": "Correct jurisdiction and disclosure position configuration", "medium": "Understands the concept", "low": "Cannot configure compliance"}},
      {"name": "analytical_skill", "weight": 20, "description": "Interprets creative feature evaluation results", "scoring_guide": {"high": "Uses feature evaluation to improve creative quality", "medium": "Can read results", "low": "Cannot interpret evaluations"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria;

-- S3: Signals and audiences
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S3', 'S', 'Signals and audiences',
 'Audience data activation, privacy, and measurement infrastructure. Signal discovery, pricing, activation/deactivation for GDPR compliance, conversion tracking, and attribution.',
 'capstone', 45, 3, false, '{A5}',
 '{
    "objectives": [
      "Master signal discovery, pricing, and activation",
      "Configure privacy-compliant audience activation and deactivation",
      "Set up conversion tracking with event sources and event logging",
      "Understand attribution models and measurement"
    ],
    "key_concepts": [
      {"topic": "Signal discovery and pricing", "teaching_notes": "get_signals with filtering by category, provider, pricing model. Three pricing models: CPM, percent-of-media, flat-fee. Signal metadata: categories for categorical signals, ranges for numeric. Show how a buyer agent evaluates signal value vs cost."},
      {"topic": "Privacy-compliant activation", "teaching_notes": "activate_signal with action: activate or deactivate. Deactivation is critical for GDPR/CCPA compliance — when a user withdraws consent, the signal must be deactivated. Consent basis tracking. Show the full lifecycle: discover → price → activate → use → deactivate on consent withdrawal."},
      {"topic": "Conversion tracking", "teaching_notes": "sync_event_sources configures what events to track. log_event records individual events (purchase, add_to_cart, lead, etc.) with batch support and partial failure handling. Content ID types for attribution (GTIN, SKU, etc.). Show the full measurement pipeline."},
      {"topic": "Attribution models", "teaching_notes": "How signals connect to campaign performance. Attribution windows, multi-touch models, view-through vs click-through. The provide_performance_feedback loop: delivery data + signals → optimization."}
    ]
  }',
 '[
    {
      "id": "s3_ex1",
      "title": "Full signals pipeline with privacy controls",
      "description": "Discover signals, activate with consent, set up conversion tracking, and handle a consent withdrawal.",
      "sandbox_actions": [
        {"tool": "get_signals", "guidance": "Discover available signals and evaluate pricing."},
        {"tool": "activate_signal", "guidance": "Activate a signal with consent basis."},
        {"tool": "sync_event_sources", "guidance": "Configure conversion event tracking."},
        {"tool": "log_event", "guidance": "Log conversion events for attribution."}
      ],
      "success_criteria": [
        "Discovers and evaluates signal pricing",
        "Activates and deactivates signals with proper consent handling",
        "Configures event tracking and logs conversion events",
        "Demonstrates understanding of attribution models"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "protocol_mastery", "weight": 30, "description": "Complete signals lifecycle", "scoring_guide": {"high": "Full pipeline from discovery to attribution", "medium": "Basic signal usage", "low": "Cannot complete the pipeline"}},
      {"name": "privacy_compliance", "weight": 25, "description": "Handles consent and deactivation correctly", "scoring_guide": {"high": "Correct consent-based activation/deactivation", "medium": "Understands the concept", "low": "Ignores privacy requirements"}},
      {"name": "measurement_skill", "weight": 25, "description": "Configures conversion tracking and attribution", "scoring_guide": {"high": "Full event tracking with attribution analysis", "medium": "Basic event logging", "low": "Cannot set up tracking"}},
      {"name": "analytical_skill", "weight": 20, "description": "Evaluates signal value and campaign performance", "scoring_guide": {"high": "Makes data-driven signal selection decisions", "medium": "Can read metrics", "low": "Cannot evaluate signal value"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria;

-- S4: Governance and brand safety
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S4', 'S', 'Governance and brand safety',
 'Content standards, property governance, and AI-driven brand safety. The Oracle model, creative feature evaluation, compliance artifacts, and property authorization at scale.',
 'capstone', 45, 4, false, '{A5}',
 '{
    "objectives": [
      "Master content standards: create, calibrate, and validate",
      "Implement property governance: authorized inventory lists and feature evaluation",
      "Understand the Oracle model for AI-driven brand safety",
      "Generate and interpret compliance artifacts"
    ],
    "key_concepts": [
      {"topic": "Content standards protocol", "teaching_notes": "7 tasks: create, get, update, list, delete, calibrate, validate. Content standards define brand-specific compliance rules. calibrate_content tunes standards per-brand. validate_content_delivery checks at delivery time. Show the full lifecycle from rule creation to delivery validation."},
      {"topic": "Property governance", "teaching_notes": "5 tasks: create, get, update, list, delete property lists. Plus get_property_features for property evaluation and validate_property_delivery for authorization checks. Property lists define which inventory is authorized — the publisher-side governance layer."},
      {"topic": "The Oracle model", "teaching_notes": "AI provenance for brand safety — using AI to evaluate content and inventory at scale. get_creative_features evaluates creative safety, quality, and categorization. get_property_features evaluates property trust scores, brand suitability, and compliance. The model operates as an independent evaluator, not controlled by buyer or seller."},
      {"topic": "Compliance artifacts", "teaching_notes": "get_media_buy_artifacts retrieves generated compliance documentation — proof that governance rules were applied. Jurisdiction-specific regulation support. This is the audit trail for brand safety decisions."}
    ]
  }',
 '[
    {
      "id": "s4_ex1",
      "title": "Governance framework design",
      "description": "Create content standards, build a property list, validate content against them, and generate compliance artifacts.",
      "sandbox_actions": [
        {"tool": "create_content_standards", "guidance": "Define brand safety rules for a fictional brand."},
        {"tool": "create_property_list", "guidance": "Create an authorized inventory list."},
        {"tool": "validate_content_delivery", "guidance": "Check content against the standards."},
        {"tool": "get_property_features", "guidance": "Evaluate property trust and suitability."}
      ],
      "success_criteria": [
        "Creates meaningful content standards with calibration",
        "Builds a property list with authorization rules",
        "Validates content and interprets results",
        "Demonstrates understanding of the Oracle model"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "protocol_mastery", "weight": 30, "description": "Complete governance protocol mastery", "scoring_guide": {"high": "Full lifecycle across both content and property governance", "medium": "One governance area well, the other basic", "low": "Cannot complete governance flows"}},
      {"name": "safety_expertise", "weight": 25, "description": "Understands brand safety at scale", "scoring_guide": {"high": "Can design a governance framework for a real brand", "medium": "Understands concepts", "low": "Superficial understanding"}},
      {"name": "oracle_understanding", "weight": 25, "description": "Understands AI-driven evaluation models", "scoring_guide": {"high": "Can explain the Oracle model and its independence", "medium": "Knows AI is involved", "low": "Does not understand the evaluation model"}},
      {"name": "compliance_skill", "weight": 20, "description": "Handles regulatory and compliance requirements", "scoring_guide": {"high": "Configures jurisdiction-specific rules with audit trail", "medium": "Basic compliance", "low": "Ignores compliance requirements"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria;

-- S5: Sponsored Intelligence (new)
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S5', 'S', 'Sponsored Intelligence',
 'Conversational brand experiences in AI assistants. Session lifecycle, A2UI component rendering, offering discovery, and the shift from impressions to conversations.',
 'capstone', 45, 5, false, '{A5}',
 '{
    "objectives": [
      "Master the Sponsored Intelligence session lifecycle",
      "Build conversational brand experiences using A2UI components",
      "Handle offering discovery within conversations",
      "Understand the economics of conversational advertising"
    ],
    "key_concepts": [
      {"topic": "Session lifecycle", "teaching_notes": "Four tasks: si_initiate_session (start conversation), si_send_message (interactive exchange), si_get_offering (retrieve offerings during conversation), si_terminate_session (close). Each session has a brand context and conversation state. Show how a brand''s tone and product catalog inform the conversation."},
      {"topic": "A2UI component system", "teaching_notes": "Agent-to-UI components for rendering brand experiences in chat interfaces. Structured components (product cards, comparison tables, booking widgets) that chat platforms render natively. The bridge between agent responses and visual user experience."},
      {"topic": "Conversational commerce", "teaching_notes": "From impressions to conversations. A user asks ''what laptop should I buy?'' and a sponsored brand can engage in a helpful, branded conversation. The brand provides value (expert advice) and the user gets a better experience than a banner ad. Show the complete flow from session initiation through offering presentation to conversion."},
      {"topic": "Economics of SI", "teaching_notes": "Cost-per-conversation vs CPM. Higher engagement, higher intent, higher value per interaction. But also higher creative investment — brands need good conversational content. Discuss when SI makes sense vs traditional display."}
    ]
  }',
 '[
    {
      "id": "s5_ex1",
      "title": "Build a sponsored intelligence integration",
      "description": "Create a conversational brand experience using the SI protocol and A2UI components.",
      "sandbox_actions": [
        {"tool": "si_initiate_session", "guidance": "Start a brand conversation session with context."},
        {"tool": "si_send_message", "guidance": "Exchange messages in the brand conversation."},
        {"tool": "si_get_offering", "guidance": "Present a product offering within the conversation."},
        {"tool": "si_terminate_session", "guidance": "Close the session gracefully."}
      ],
      "success_criteria": [
        "Initiates a branded conversation session",
        "Exchanges meaningful messages with offering integration",
        "Uses A2UI components for visual presentation",
        "Can explain when SI is better than traditional advertising"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "protocol_mastery", "weight": 30, "description": "Complete SI session lifecycle", "scoring_guide": {"high": "Full session from initiation through offering to termination", "medium": "Basic session flow", "low": "Cannot complete a session"}},
      {"name": "conversational_design", "weight": 25, "description": "Creates engaging branded conversations", "scoring_guide": {"high": "Natural, helpful conversation with good brand voice", "medium": "Functional but generic", "low": "Robotic or unhelpful"}},
      {"name": "component_usage", "weight": 25, "description": "Effectively uses A2UI components", "scoring_guide": {"high": "Rich visual presentation with appropriate components", "medium": "Basic component usage", "low": "No visual presentation"}},
      {"name": "strategic_thinking", "weight": 20, "description": "Understands when and why to use SI", "scoring_guide": {"high": "Can articulate SI economics and appropriate use cases", "medium": "Understands the basics", "low": "Does not understand the value proposition"}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria;

-- =====================================================
-- CREDENTIAL UPDATES
-- =====================================================

-- Rename Basics → Explorer, expand to include A3 (catalogs)
UPDATE certification_credentials SET
  name = 'AdCP Explorer',
  description = 'Queried live agents, executed a media buy, explored product catalogs. Understands what agentic advertising is and what AdCP can do. Free and open to everyone.',
  required_modules = '{A1,A2,A3}'
WHERE id = 'basics';

-- Update Practitioner to require A1-A5 + track
UPDATE certification_credentials SET
  description = 'Created a working AdCP integration through a hands-on build project. Deep protocol knowledge with demonstrated ability to build with AdCP.',
  required_modules = '{A1,A2,A3,A4,A5}'
WHERE id = 'practitioner';

-- Update specialist required modules from E→S
UPDATE certification_credentials SET required_modules = '{S1}' WHERE id = 'specialist_media_buy';
UPDATE certification_credentials SET required_modules = '{S2}' WHERE id = 'specialist_creative';
UPDATE certification_credentials SET required_modules = '{S3}' WHERE id = 'specialist_signals';
UPDATE certification_credentials SET required_modules = '{S4}' WHERE id = 'specialist_governance';

-- Add Sponsored Intelligence specialist credential
INSERT INTO badges (id, name, description, icon, category) VALUES
  ('adcp_specialist_si', 'AdCP specialist — Sponsored Intelligence', 'Protocol specialist in conversational brand experiences, session lifecycle, and A2UI component rendering', 'specialist', 'certification')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

INSERT INTO certification_credentials (id, tier, name, description, required_modules, requires_any_track_complete, requires_credential, badge_id, certifier_group_id, sort_order) VALUES
  ('specialist_si', 3, 'AdCP Specialist — Sponsored Intelligence',
   'Protocol specialist in conversational commerce. Demonstrates mastery of Sponsored Intelligence sessions, A2UI components, and branded conversation design.',
   '{S5}', false, 'practitioner', 'adcp_specialist_si', NULL, 7)
ON CONFLICT (id) DO UPDATE SET
  tier = EXCLUDED.tier,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  required_modules = EXCLUDED.required_modules,
  requires_any_track_complete = EXCLUDED.requires_any_track_complete,
  requires_credential = EXCLUDED.requires_credential,
  badge_id = EXCLUDED.badge_id,
  sort_order = EXCLUDED.sort_order;

-- Update badge name for Explorer
UPDATE badges SET
  name = 'AdCP explorer',
  description = 'Completed AdCP explorer path — queried live agents, executed a media buy, and explored product catalogs'
WHERE id = 'adcp_basics';

-- Update Practitioner badge description
UPDATE badges SET
  description = 'Created a working AdCP integration through hands-on build project with interactive exercises'
WHERE id = 'adcp_practitioner';

-- Clean up: remove E track if no modules reference it
DELETE FROM certification_tracks WHERE id = 'E'
  AND NOT EXISTS (SELECT 1 FROM certification_modules WHERE track_id = 'E');
