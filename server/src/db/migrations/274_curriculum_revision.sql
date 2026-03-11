-- Curriculum revision: expand from 14 to 19 modules
-- - Keep credential name 'AdCP Basics' (credential ID stays 'basics' for data stability)
-- - A1: Why AdCP (value prop), A2: Your first media buy, A3: The AdCP landscape (survey)
-- - Basics = A1 + A2 + A3 (all free, ~50 min)
-- - Replace E track capstones with S track specialists (S1-S5)
-- - Add build projects (B4, C4, D4) as practitioner gates
-- - Expand B1, B3, C1, D1 for broader task coverage
-- - All exercises use @cptestagent (the only sandbox agent we control)

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
  description = 'Required for all learners. Understand why AdCP matters, execute a real media buy, and tour the full protocol landscape.'
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
-- MODULE UPDATES — Track A (Basics, all free)
-- =====================================================

-- A1: Why AdCP — the value prop
UPDATE certification_modules SET
  title = 'Why AdCP',
  description = 'Why agentic advertising matters, what problem AdCP solves, and why a shared protocol changes everything. Grounded with a live agent query against @cptestagent.',
  duration_minutes = 15,
  is_free = true,
  lesson_plan = '{
    "objectives": [
      "Explain the difference between agentic and traditional programmatic advertising",
      "Understand AdCP covers 19 channels including linear TV, radio, print, and DOOH — not just digital",
      "Query a live agent and interpret the response",
      "Articulate why a shared protocol matters for AI-powered advertising"
    ],
    "key_concepts": [
      {"topic": "Agentic vs traditional programmatic", "teaching_notes": "Start hands-on: have the learner query @cptestagent immediately using get_products. After they see a real response, explain the paradigm shift — goal-driven agents vs rigid APIs. Let the protocol speak for itself before lecturing."},
      {"topic": "Not just digital", "teaching_notes": "AdCP covers 19 channels: display, social, search, CTV, linear TV, AM/FM radio, podcast, streaming audio, DOOH, OOH, print, cinema, email, gaming, retail media, influencer, affiliate, product placement. Can you buy local radio? Yes. Broadcast syndication? Yes. The same protocol buys a TikTok ad and a local news spot."},
      {"topic": "AI agents in advertising", "teaching_notes": "An agent perceives, decides, and acts autonomously. In advertising, agents discover inventory, negotiate pricing, manage creatives, and optimize campaigns. Use the live @cptestagent interaction to ground this — the learner just talked to an agent."},
      {"topic": "The protocol hierarchy", "teaching_notes": "AdCP is built on MCP (Model Context Protocol). MCP handles transport. AdCP adds the advertising domain. Multiple transports work: MCP and A2A. Keep this brief — the point is that AdCP works across different connection methods."}
    ],
    "demo_scenarios": [
      {"description": "Query @cptestagent for available products", "tools": ["get_products"], "expected_outcome": "See products with pricing, targeting options, and format support — a real agent response, not a slide deck"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "a1_ex1",
      "title": "Your first agent conversation",
      "description": "Query @cptestagent and explore what products are available across channels.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Query @cptestagent. Look at the products returned — notice pricing models, targeting options, channel types. The protocol is identical regardless of channel."}
      ],
      "success_criteria": [
        "Successfully queries @cptestagent and gets a product response",
        "Can identify what information a product response contains (pricing, targeting, formats)",
        "Understands that the same protocol works across all channels"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "conceptual_understanding", "weight": 25, "description": "Understands agentic vs traditional paradigm", "scoring_guide": {"high": "Can articulate the shift from APIs to agents with concrete examples", "medium": "Understands the difference but misses nuances", "low": "Confuses agents with traditional APIs"}},
      {"name": "practical_knowledge", "weight": 35, "description": "Can query an agent and interpret responses", "scoring_guide": {"high": "Successfully queries @cptestagent, interprets response fields, identifies channel differences", "medium": "Can query but struggles with interpretation", "low": "Cannot complete a basic agent query"}},
      {"name": "channel_breadth", "weight": 20, "description": "Understands AdCP is not just digital", "scoring_guide": {"high": "Can name multiple non-digital channels and explain how they work in AdCP", "medium": "Knows AdCP covers more than digital", "low": "Thinks AdCP is only for programmatic display"}},
      {"name": "protocol_fluency", "weight": 20, "description": "Uses AdCP terminology correctly", "scoring_guide": {"high": "Correctly uses terms like MCP, agent, get_products, channel", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A1';

-- A2: Your first media buy — hands-on lifecycle
UPDATE certification_modules SET
  title = 'Your first media buy',
  description = 'Step by step through the full media buy lifecycle with @cptestagent. Describe your audience and goals — watch discovery, purchase, creative sync, and delivery reporting execute in sequence.',
  duration_minutes = 20,
  is_free = true,
  lesson_plan = '{
    "objectives": [
      "Direct Addie to execute a real media buy against @cptestagent",
      "Trace the full transaction flow: discovery → purchase → creative → measurement",
      "Understand agent roles: buyer agent orchestrates, sales agent responds",
      "See the actual protocol messages at each stage"
    ],
    "key_concepts": [
      {"topic": "Directing a media buy", "teaching_notes": "The learner tells Addie what they want: audience, goals, budget. Addie orchestrates the buy against @cptestagent. The learner is not coding — they are specifying intent. This is the fundamental interaction pattern of agentic advertising."},
      {"topic": "The transaction flow", "teaching_notes": "Walk through each step as it happens: get_products (discovery), create_media_buy (purchase), sync_creatives (creative), get_media_buy_delivery (measurement). Show the actual protocol messages. Each step is a distinct protocol task."},
      {"topic": "Agent roles in action", "teaching_notes": "Point out each agent''s role as the transaction unfolds. The buyer agent finds inventory. The sales agent responds with products. The creative agent adapts assets. Multiple agents collaborate on one campaign."},
      {"topic": "What just happened", "teaching_notes": "After the buy completes, step back and review: you just bought media through an AI agent using an open protocol. No DSP dashboard. No manual insertion orders. The same protocol would work with any AdCP-compliant seller."}
    ],
    "demo_scenarios": [
      {"description": "Execute a media buy against @cptestagent", "tools": ["get_products", "create_media_buy", "sync_creatives", "get_media_buy_delivery"], "expected_outcome": "Complete a media buy lifecycle, see creatives synced and delivery metrics reported"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "a2_ex1",
      "title": "Your first buy",
      "description": "Tell Addie about an audience you want to reach and watch a real media buy execute against @cptestagent.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Addie discovers available inventory from @cptestagent."},
        {"tool": "create_media_buy", "guidance": "Addie executes the buy based on the learner''s brief."},
        {"tool": "sync_creatives", "guidance": "Addie syncs creatives to the purchased inventory."},
        {"tool": "get_media_buy_delivery", "guidance": "Addie shows delivery metrics after the buy is placed."}
      ],
      "success_criteria": [
        "Successfully directs a media buy by describing target audience and goals",
        "Can identify each step of the transaction flow as it happens",
        "Understands which protocol task handles which part of the lifecycle"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "conceptual_understanding", "weight": 25, "description": "Understands the transaction flow and agent roles", "scoring_guide": {"high": "Can describe each step and which protocol task handles it", "medium": "Gets main steps right but misses details", "low": "Cannot trace the transaction flow"}},
      {"name": "practical_knowledge", "weight": 35, "description": "Can direct a media buy and interpret results", "scoring_guide": {"high": "Successfully directs a buy and understands the delivery report", "medium": "Can direct but struggles interpreting results", "low": "Cannot complete a media buy"}},
      {"name": "problem_solving", "weight": 15, "description": "Can reason about what happens when things go wrong", "scoring_guide": {"high": "Identifies failure points and asks good questions", "medium": "Identifies some issues", "low": "Cannot reason about failures"}},
      {"name": "protocol_fluency", "weight": 25, "description": "Uses correct task names and agent roles", "scoring_guide": {"high": "Names tasks and roles correctly", "medium": "Mostly correct", "low": "Frequently misnames things"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A2';

-- A3: The AdCP landscape — survey course (FREE)
UPDATE certification_modules SET
  title = 'The AdCP landscape',
  is_free = true,
  description = 'A 101 tour of everything in AdCP. Touch every protocol domain, discover brand.json and adagents.json, and see the map of the world you could explore as a Practitioner.',
  duration_minutes = 15,
  lesson_plan = '{
    "objectives": [
      "Tour all 8 protocol domains and understand what each covers",
      "Understand brand.json and its role in machine-readable brand identity",
      "Understand adagents.json and agent discovery",
      "Know how the community registry and AgenticAdvertising.org work",
      "Be curious enough about at least one domain to pursue Practitioner"
    ],
    "key_concepts": [
      {"topic": "Discovery and community", "teaching_notes": "Three discovery mechanisms: (1) brand.json at /.well-known/brand.json — your brand''s machine-readable identity with portfolio architecture, authorized operators, tone of voice. Four variants: house portfolio, brand agent, house redirect, authoritative location redirect. (2) adagents.json — how publishers declare which agents can access their inventory, like robots.txt for agents. (3) Community registry — how agents and brands find each other, register, discover sellers, verify authorization. Also cover AgenticAdvertising.org: working groups, industry councils, how the spec evolves."},
      {"topic": "Media buy beyond the basics", "teaching_notes": "A2 covered the basic lifecycle. There''s much more: proposals and delivery forecasting, budget points, refinement protocol for negotiations, package requests, keyword targeting, geo-proximity targeting. The media buy domain has a whole negotiation protocol. Tasks: update_media_buy, package, get_media_buys."},
      {"topic": "Creative", "teaching_notes": "Formats vs manifests — the format is what inventory accepts, the manifest is what gets delivered. 19 channels of creative adaptation. AI-powered generation with build_creative, preview with preview_creative. Compliance and disclosures across jurisdictions. Tasks: list_creative_formats, list_creatives, build_creative, preview_creative, get_creative_delivery, get_creative_features."},
      {"topic": "Catalogs", "teaching_notes": "13 catalog types: product, store, promotion, hotel, flight, job, vehicle, real_estate, education, destination, app, inventory, offering. Feed field mappings normalize data without preprocessing. Catalogs connect to creatives through field bindings — this is how dynamic creative works. Task: sync_catalogs."},
      {"topic": "Accounts and billing", "teaching_notes": "How money flows: sync_accounts establishes billing relationships, list_accounts manages them. Operator-billed (agency invoiced) vs agent-billed (agent consolidates). get_adcp_capabilities discovers what a seller supports — runtime negotiation instead of static documentation. get_account_financials and report_usage for billing. brand.json authorized_operators controls who can buy on behalf of a brand."},
      {"topic": "Signals and measurement", "teaching_notes": "get_signals discovers available audience data with pricing models (CPM, percent-of-media, flat-fee). activate_signal turns them on (and off for GDPR compliance). sync_audiences for custom segments. sync_event_sources and log_event for conversion tracking. provide_performance_feedback closes the optimization loop."},
      {"topic": "Governance", "teaching_notes": "Content standards define brand safety rules. The Oracle model — using AI to evaluate content and inventory at scale, as an independent evaluator. Property lists define authorized inventory. Compliance artifacts provide the audit trail. 14 governance tasks total (CRUD for standards and properties, plus calibration and validation)."},
      {"topic": "Sponsored Intelligence", "teaching_notes": "A genuinely new advertising model — conversational brand experiences in AI assistants. si_initiate_session starts a branded conversation, si_send_message exchanges messages, si_get_offering presents products, si_terminate_session closes. Cost-per-conversation instead of CPM. A2UI components render brand experiences in chat interfaces."}
    ],
    "demo_scenarios": [
      {"description": "Discover seller capabilities", "tools": ["get_adcp_capabilities"], "expected_outcome": "See what @cptestagent supports — targeting, reporting, features"},
      {"description": "Peek at available signals", "tools": ["get_signals"], "expected_outcome": "See signal types, categories, and pricing models"},
      {"description": "See creative format options", "tools": ["list_creative_formats"], "expected_outcome": "See available formats across channels with their specifications"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "a3_ex1",
      "title": "The grand tour",
      "description": "Addie walks through each protocol domain with a quick live example from @cptestagent — capabilities, signals, formats. No deep dives, just enough to understand what each area does.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "What does this agent support? Targeting, reporting, features."},
        {"tool": "get_signals", "guidance": "What audience signals are available? What do they cost?"},
        {"tool": "list_creative_formats", "guidance": "What creative formats does this inventory accept?"}
      ],
      "success_criteria": [
        "Can name all 8 protocol domains and give a one-sentence description of each",
        "Understands what brand.json is and why it matters",
        "Understands what adagents.json is",
        "Can explain the difference between format and manifest",
        "Knows what Sponsored Intelligence is"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "breadth", "weight": 35, "description": "Awareness of all protocol domains", "scoring_guide": {"high": "Can describe all 8 domains and name key tasks in each", "medium": "Knows most domains but fuzzy on some", "low": "Only aware of media buy basics"}},
      {"name": "discovery_mechanisms", "weight": 25, "description": "Understands brand.json, adagents.json, community registry", "scoring_guide": {"high": "Can explain all three discovery mechanisms and why they matter", "medium": "Knows about one or two", "low": "Unaware of discovery infrastructure"}},
      {"name": "key_concepts", "weight": 25, "description": "Grasps format vs manifest, billing models, Oracle model", "scoring_guide": {"high": "Can explain each concept clearly", "medium": "Understands some", "low": "Confused about key distinctions"}},
      {"name": "synthesis", "weight": 15, "description": "Can connect concepts across domains without prompting", "scoring_guide": {"high": "Independently draws connections between domains (e.g. how governance affects media buy, how signals feed creative)", "medium": "Makes connections when prompted", "low": "Treats each domain as isolated"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A3';

-- =====================================================
-- MODULE UPDATES — Expanded role track modules
-- =====================================================

-- B1: Expand to include sync_catalogs, get_adcp_capabilities
UPDATE certification_modules SET
  title = 'Designing your product catalog',
  description = 'Build your sales agent''s inventory: product design, pricing models, catalog integration, and capability advertisement. How buyers discover you through adagents.json and get_adcp_capabilities.',
  duration_minutes = 20,
  prerequisites = '{A3}',
  lesson_plan = '{
    "objectives": [
      "Design a product catalog with pricing models, targeting, and format support",
      "Use sync_catalogs to integrate product data from feeds",
      "Configure get_adcp_capabilities to advertise what you support",
      "Understand how buyers find you: adagents.json, brand authorization, capabilities"
    ],
    "key_concepts": [
      {"topic": "Product catalog design", "teaching_notes": "get_products response design: pricing models (CPM, CPC, flat-rate), targeting options, format support, availability windows. Agent guardrails: minimum CPMs, maximum discounts, acceptable categories. The catalog is your storefront."},
      {"topic": "Catalog integration", "teaching_notes": "sync_catalogs for product data: 13 catalog types, feed field mappings. Accept feeds from Google Merchant Center, Facebook Catalog, Shopify, etc. Field mappings normalize without preprocessing. Item-level approval workflow."},
      {"topic": "Capability advertisement", "teaching_notes": "get_adcp_capabilities replaces static agent cards with runtime negotiation. The seller tells buyers what targeting, reporting, and features they support. This is how agents discover each other''s capabilities programmatically."},
      {"topic": "Discovery: adagents.json and brand authorization", "teaching_notes": "adagents.json declares which agents can access your inventory. brand.json authorized_operators shows who can buy on behalf of a brand. Together these form the trust layer for agent-to-agent commerce."}
    ],
    "demo_scenarios": [
      {"description": "Design a product catalog", "tools": ["get_products"], "expected_outcome": "See how @cptestagent structures its product responses — pricing, targeting, formats"},
      {"description": "Sync product data", "tools": ["sync_catalogs"], "expected_outcome": "Upload product data to @cptestagent and see item-level approval"},
      {"description": "Discover capabilities", "tools": ["get_adcp_capabilities"], "expected_outcome": "See what a seller advertises as supported features"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "b1_ex1",
      "title": "Build your storefront",
      "description": "Design a product catalog for a fictional publisher. Sync product data. Configure capabilities.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Study how @cptestagent structures its product catalog — pricing, targeting, formats."},
        {"tool": "sync_catalogs", "guidance": "Sync a small product catalog with at least 3 items. See the approval status."},
        {"tool": "get_adcp_capabilities", "guidance": "See what capabilities @cptestagent advertises. Design your own capability set."}
      ],
      "success_criteria": [
        "Designs a coherent product catalog with appropriate pricing models",
        "Successfully syncs catalog data and interprets approval responses",
        "Can explain how buyers discover sellers through capabilities and adagents.json"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "catalog_design", "weight": 30, "description": "Designs a coherent product catalog", "scoring_guide": {"high": "Well-structured catalog with appropriate pricing, targeting, and formats", "medium": "Basic catalog with some gaps", "low": "Incomplete or incoherent catalog design"}},
      {"name": "practical_knowledge", "weight": 30, "description": "Can sync catalogs and configure capabilities", "scoring_guide": {"high": "Successfully syncs data and configures capabilities", "medium": "Can do it with guidance", "low": "Cannot complete sync or capability setup"}},
      {"name": "discovery_understanding", "weight": 20, "description": "Understands how buyers find sellers", "scoring_guide": {"high": "Can explain adagents.json, capabilities, and brand authorization", "medium": "Knows one mechanism", "low": "Does not understand discovery"}},
      {"name": "protocol_fluency", "weight": 20, "description": "Uses correct terminology", "scoring_guide": {"high": "Correctly uses catalog types, field mappings, capabilities", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'B1';

-- B3: Expand to cover signals, activate_signal, sync_audiences, sync_accounts, list_accounts
UPDATE certification_modules SET
  title = 'Measurement, signals, and optimization',
  description = 'Delivery metrics, signal activation, audience syncing, conversion tracking, account management, and the optimization feedback loop.',
  duration_minutes = 20,
  lesson_plan = '{
    "objectives": [
      "Analyze delivery metrics with dimension breakdowns",
      "Configure signal discovery, pricing, and activation",
      "Handle audience syncing and event tracking",
      "Manage buyer accounts and performance feedback",
      "Understand the full optimization loop"
    ],
    "key_concepts": [
      {"topic": "Delivery reporting", "teaching_notes": "get_media_buy_delivery: delivery metrics, opt-in reporting_dimensions (by_geo, by_device, by_keyword, by_catalog_item, by_package). Dimension arrays with truncation flags. Sort capability declarations. This is how sellers expose campaign performance."},
      {"topic": "Signals and activation", "teaching_notes": "get_signals discovers available audience data with pricing (CPM, percent-of-media, flat-fee). activate_signal turns signals on — and critically, off for GDPR/CCPA compliance. Signal categories, metadata. The seller''s role is offering signals and honoring deactivation requests."},
      {"topic": "Event tracking and audiences", "teaching_notes": "sync_event_sources configures what events to track. log_event records conversions (purchase, add_to_cart, lead) with batch support. sync_audiences accepts buyer-provided audience segments. These form the measurement infrastructure."},
      {"topic": "Account management", "teaching_notes": "sync_accounts manages buyer relationships — account provisioning, billing model (operator-billed vs agent-billed), credit limits. list_accounts shows all active accounts. This is the commercial infrastructure."},
      {"topic": "Performance feedback loop", "teaching_notes": "provide_performance_feedback: how buyers signal what''s working. Delivery data + signals + feedback → optimization. This closes the loop between measurement and action."}
    ],
    "demo_scenarios": [
      {"description": "Review delivery metrics", "tools": ["get_media_buy_delivery"], "expected_outcome": "See delivery data with dimension breakdowns"},
      {"description": "Discover and activate signals", "tools": ["get_signals", "activate_signal"], "expected_outcome": "See available signals, activate one with pricing"},
      {"description": "Sync audiences and track events", "tools": ["sync_audiences", "sync_event_sources", "log_event"], "expected_outcome": "Accept an audience segment and configure event tracking"},
      {"description": "Manage accounts", "tools": ["sync_accounts", "list_accounts"], "expected_outcome": "See buyer accounts and their status"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "b3_ex1",
      "title": "The measurement stack",
      "description": "Configure signals and event tracking. Handle an audience sync. Review delivery by dimension. Manage buyer accounts.",
      "sandbox_actions": [
        {"tool": "get_media_buy_delivery", "guidance": "Review delivery metrics with dimension breakdowns."},
        {"tool": "get_signals", "guidance": "Discover available signals and their pricing."},
        {"tool": "activate_signal", "guidance": "Activate a signal. Then deactivate to simulate consent withdrawal."},
        {"tool": "sync_audiences", "guidance": "Accept a buyer audience segment."},
        {"tool": "sync_event_sources", "guidance": "Configure conversion event tracking."},
        {"tool": "log_event", "guidance": "Log a conversion event."},
        {"tool": "sync_accounts", "guidance": "Set up a buyer account."},
        {"tool": "list_accounts", "guidance": "Review active buyer accounts."}
      ],
      "success_criteria": [
        "Can analyze delivery metrics across dimensions",
        "Configures signals and handles activation/deactivation",
        "Accepts audience segments and configures event tracking",
        "Manages buyer accounts with appropriate billing models"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "measurement_skill", "weight": 30, "description": "Analyzes delivery data effectively", "scoring_guide": {"high": "Uses dimension breakdowns to derive insights", "medium": "Can read delivery reports", "low": "Cannot interpret delivery data"}},
      {"name": "signals_knowledge", "weight": 25, "description": "Configures signals and handles privacy", "scoring_guide": {"high": "Correct activation/deactivation with consent handling", "medium": "Can activate but misses deactivation", "low": "Cannot configure signals"}},
      {"name": "infrastructure", "weight": 25, "description": "Sets up audiences, events, and accounts", "scoring_guide": {"high": "Full measurement infrastructure configured", "medium": "Partial setup", "low": "Cannot complete setup"}},
      {"name": "protocol_fluency", "weight": 20, "description": "Uses correct terminology", "scoring_guide": {"high": "Correctly names all tasks and concepts", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'B3';

-- C1: Expand to include sync_audiences, sync_accounts
UPDATE certification_modules SET
  title = 'Multi-agent buying and media planning',
  description = 'Orchestrate across multiple sellers: discovery, proposals, package requests, audience targeting, account setup, and campaign management.',
  duration_minutes = 20,
  prerequisites = '{A3}',
  lesson_plan = '{
    "objectives": [
      "Orchestrate product discovery across multiple agents",
      "Create and update media buys with targeting and budget",
      "Set up accounts and sync audience segments before buying",
      "Use proposals and packages for budget planning"
    ],
    "key_concepts": [
      {"topic": "Multi-agent orchestration", "teaching_notes": "The buyer agent''s core pattern: discover → evaluate → allocate → execute → monitor. Query multiple sales agents in parallel using get_products. Compare products, pricing, targeting options across sellers. This is portfolio-level media planning."},
      {"topic": "Account and audience setup", "teaching_notes": "Before buying, establish billing with sync_accounts — choose operator-billed or agent-billed. Sync custom audience segments with sync_audiences so sellers can target your users. This is the setup work that makes buying possible."},
      {"topic": "Proposals and packages", "teaching_notes": "Budget points, forecast methods (estimate, modeled, guaranteed). package requests for bundled inventory. The refinement protocol (update_media_buy) for post-buy modifications. This is how negotiation works in AdCP."},
      {"topic": "Campaign management", "teaching_notes": "update_media_buy for modifications. get_media_buys to list active campaigns. The buyer agent manages the lifecycle across multiple sellers simultaneously."}
    ],
    "demo_scenarios": [
      {"description": "Set up an account and sync audiences", "tools": ["sync_accounts", "sync_audiences"], "expected_outcome": "Billing account established, audience segments available for targeting"},
      {"description": "Multi-seller discovery and buying", "tools": ["get_products", "create_media_buy", "update_media_buy"], "expected_outcome": "Compare products across sellers, execute a buy, modify it"},
      {"description": "Package and proposal exploration", "tools": ["package"], "expected_outcome": "See package options and budget planning"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "c1_ex1",
      "title": "Plan a multi-seller campaign",
      "description": "Set up billing, sync audience segments, discover products from @cptestagent, and execute a media buy with targeting.",
      "sandbox_actions": [
        {"tool": "sync_accounts", "guidance": "Establish a billing account for your fictional brand."},
        {"tool": "sync_audiences", "guidance": "Sync a custom audience segment for targeting."},
        {"tool": "get_products", "guidance": "Discover available inventory."},
        {"tool": "create_media_buy", "guidance": "Execute a buy with your synced audience as targeting."},
        {"tool": "update_media_buy", "guidance": "Modify the buy — change budget, adjust targeting."},
        {"tool": "package", "guidance": "Explore package options for bundled inventory."}
      ],
      "success_criteria": [
        "Sets up billing and audience targeting before buying",
        "Discovers and compares products across the sandbox",
        "Executes and modifies a media buy",
        "Understands the buyer orchestration pattern"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "orchestration", "weight": 30, "description": "Plans and executes a multi-step buying workflow", "scoring_guide": {"high": "Complete workflow from account setup through buying and modification", "medium": "Can buy but misses setup steps", "low": "Cannot orchestrate the full flow"}},
      {"name": "practical_knowledge", "weight": 30, "description": "Uses buying tasks correctly", "scoring_guide": {"high": "Correctly uses all buying tasks with appropriate parameters", "medium": "Handles basic buying", "low": "Cannot complete a buy"}},
      {"name": "planning_skill", "weight": 20, "description": "Makes smart allocation decisions", "scoring_guide": {"high": "Considers budget, audience, and format when allocating", "medium": "Basic allocation", "low": "No planning rationale"}},
      {"name": "protocol_fluency", "weight": 20, "description": "Uses correct task names and buying concepts", "scoring_guide": {"high": "Correctly names all tasks and concepts", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'C1';

-- D1: Expand to include sync_accounts handling
UPDATE certification_modules SET
  title = 'MCP server architecture',
  description = 'Build an AdCP-compliant MCP server. Tool registration, transport options, OAuth 2.0, capability advertisement, and handling incoming account requests.',
  duration_minutes = 20,
  prerequisites = '{A3}',
  lesson_plan = '{
    "objectives": [
      "Understand MCP server tool registration and request routing",
      "Choose between Streamable HTTP and SSE transport",
      "Implement OAuth 2.0 for agent authentication",
      "Advertise capabilities with get_adcp_capabilities",
      "Handle incoming sync_accounts from buyer agents"
    ],
    "key_concepts": [
      {"topic": "MCP server architecture", "teaching_notes": "Tool registration maps AdCP tasks to handler functions. Request routing dispatches incoming tool calls. The server is the runtime for your sales agent — it translates protocol messages into business logic."},
      {"topic": "Transport options", "teaching_notes": "Streamable HTTP is the primary transport — standard HTTP requests with streaming responses. SSE (Server-Sent Events) for real-time updates. Both work with MCP. Choose based on your infrastructure — most implementations start with Streamable HTTP."},
      {"topic": "Authentication and authorization", "teaching_notes": "OAuth 2.0 for agent authentication. Token-based authorization with scopes. How to verify incoming agent identity and brand authorization. This is the security layer."},
      {"topic": "Capability and account handling", "teaching_notes": "get_adcp_capabilities advertises what your server supports — targeting, reporting, features. sync_accounts handles incoming account setup from buyers — provisioning billing, setting credit limits, returning account status. These are the handshake tasks."}
    ],
    "demo_scenarios": [
      {"description": "Scaffold an MCP server", "tools": ["get_adcp_capabilities"], "expected_outcome": "See how @cptestagent advertises capabilities — model your own"},
      {"description": "Handle account setup", "tools": ["sync_accounts"], "expected_outcome": "See how account provisioning works from the seller side"}
    ]
  }',
  exercise_definitions = '[
    {
      "id": "d1_ex1",
      "title": "Scaffold your AdCP server",
      "description": "Design the tool registration, capability advertisement, and account handling for an MCP server.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "Study @cptestagent''s capabilities response. Design your own capability set."},
        {"tool": "sync_accounts", "guidance": "See how account provisioning works. Plan your account handling logic."}
      ],
      "success_criteria": [
        "Can describe MCP server architecture and tool registration",
        "Designs appropriate capability advertisement",
        "Understands OAuth 2.0 flow for agent authentication",
        "Plans account handling logic for incoming buyer requests"
      ]
    }
  ]',
  assessment_criteria = '{
    "dimensions": [
      {"name": "architecture", "weight": 30, "description": "Understands MCP server structure", "scoring_guide": {"high": "Can describe tool registration, routing, and transport options", "medium": "Understands the basics", "low": "Confused about server architecture"}},
      {"name": "practical_knowledge", "weight": 30, "description": "Can design capabilities and account handling", "scoring_guide": {"high": "Well-designed capability set and account workflow", "medium": "Basic design", "low": "Cannot design infrastructure"}},
      {"name": "security", "weight": 20, "description": "Understands authentication and authorization", "scoring_guide": {"high": "Can explain OAuth 2.0 flow and agent verification", "medium": "Knows auth is needed", "low": "Ignores security"}},
      {"name": "protocol_fluency", "weight": 20, "description": "Uses correct infrastructure terminology", "scoring_guide": {"high": "Correctly uses MCP, transport, OAuth terms", "medium": "Mostly correct", "low": "Misuses terminology"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'D1';

-- =====================================================
-- BUILD PROJECT MODULES — B4, C4, D4
-- =====================================================

-- B4: Publisher build project
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('B4', 'B', 'Build project — your first sales agent',
 'Create a working sales agent that responds to real buyer queries. Use any AI coding assistant (Claude Code, Cursor, Copilot) with the adcp client library. The skill tested is specifying correct AdCP behavior.',
 'capstone', 45, 4, false, '{B3}',
 '{
    "objectives": [
      "Specify AdCP agent requirements well enough for a coding assistant to build it",
      "Validate agent responses against AdCP schemas",
      "Explain design decisions and reason about extensions",
      "Evaluate, debug, and extend AI-generated AdCP code"
    ],
    "key_concepts": [
      {"topic": "Phase 1: Specify (~5 min)", "teaching_notes": "Help the learner craft a prompt for their AI coding assistant. They need to pick a scenario — local news publisher, podcast network, regional event company, niche content site — and describe their products, pricing models, and creative formats using AdCP terminology from B1-B3. This is the first assessment: can they specify an agent in protocol terms? Ask: What products will you offer? What pricing model? What formats? What channels? Do NOT write the prompt for them."},
      {"topic": "Phase 2: Build (~5 min)", "teaching_notes": "The learner goes to their coding assistant and builds the agent. They should use the adcp client library (pip install adcp or npm). This is the fast part — tell them to come back when it''s running. If they hit issues, help them refine their prompt, don''t debug code."},
      {"topic": "Phase 3: Validate (~10 min)", "teaching_notes": "Give the learner specific MCP tool calls to run against their local agent and paste the results back. Start with: (1) get_products with a broad brief — check schema compliance, product count, pricing structure. (2) create_media_buy with valid params — check the response. (3) create_media_buy with invalid params (bad product ID, budget too low) — check error handling. (4) list_creative_formats — check format definitions. Validate each response against AdCP schemas. If something fails, tell them exactly what''s wrong so they can fix it with their coding assistant."},
      {"topic": "Phase 4: Explain (~10 min)", "teaching_notes": "Now the real assessment. Ask probing questions about their agent: Why did you choose that pricing model? What happens if two buyers request the same inventory slot? How would you add audience targeting? What''s the difference between the format you defined and a manifest? Could a buyer agent discover your inventory through adagents.json? The learner should reason about their agent, not just describe what it does. This is where B1-B3 knowledge shows."},
      {"topic": "Phase 5: Extend (~15 min)", "teaching_notes": "Give the learner a challenge that requires them to go back to their coding assistant and add something: (1) Add a product with geo-proximity targeting. (2) Add get_media_buy_delivery that returns plausible metrics. (3) Handle sync_catalogs for product data updates. They come back, paste the new output, and explain what changed. This tests whether they can iterate on AdCP implementations, not just generate them."}
    ]
  }',
 '[
    {
      "id": "b4_specify",
      "title": "Specify your sales agent",
      "description": "Choose a publisher scenario and describe what your sales agent should offer — products, pricing, formats, channels — using AdCP terminology.",
      "sandbox_actions": [],
      "success_criteria": [
        "Learner describes at least 3 products with specific pricing models",
        "Learner specifies creative formats with dimensions and channels",
        "Specification uses correct AdCP terminology (not generic terms)"
      ]
    },
    {
      "id": "b4_validate",
      "title": "Validate your agent",
      "description": "Run specific MCP tool calls against your local agent and paste the results. Addie checks schema compliance and error handling.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Learner runs a get_products call with a broad brief and pastes the JSON response. Validate against schema."},
        {"tool": "create_media_buy", "guidance": "Learner runs valid and invalid create_media_buy calls. Check response structure and error handling."},
        {"tool": "list_creative_formats", "guidance": "Learner queries format support. Validate dimensions, file types, render specs."}
      ],
      "success_criteria": [
        "get_products returns schema-compliant output with at least 3 products",
        "create_media_buy handles valid requests correctly",
        "Invalid requests return proper AdCP error responses",
        "list_creative_formats returns valid format definitions"
      ]
    },
    {
      "id": "b4_extend",
      "title": "Extend your agent",
      "description": "Add a new capability to your agent: geo-proximity targeting, delivery reporting, or catalog sync. Explain what changed and why.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Re-validate after extension. Check that new capability is reflected."},
        {"tool": "get_media_buy_delivery", "guidance": "If they added delivery reporting, validate the response schema."}
      ],
      "success_criteria": [
        "Agent has a new capability that wasn''t in the original build",
        "New responses pass schema validation",
        "Learner can explain what they asked the coding assistant to add and why"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "specification_quality", "weight": 20, "description": "Can specify an agent in AdCP terms", "scoring_guide": {"high": "Describes products, pricing, formats using correct AdCP terminology without help", "medium": "Needs some prompting to use correct terms", "low": "Cannot describe requirements in AdCP terms"}},
      {"name": "schema_compliance", "weight": 25, "description": "Agent responses validate against AdCP schemas", "scoring_guide": {"high": "All responses pass schema validation", "medium": "Most responses valid with minor issues", "low": "Responses fail schema validation"}},
      {"name": "error_handling", "weight": 15, "description": "Handles invalid requests with proper AdCP errors", "scoring_guide": {"high": "Returns proper error responses with recovery types", "medium": "Handles some error cases", "low": "Crashes on invalid input"}},
      {"name": "design_rationale", "weight": 20, "description": "Can explain and reason about design decisions", "scoring_guide": {"high": "Clear rationale for catalog design, pricing, and extension points", "medium": "Can explain basics but not trade-offs", "low": "Cannot articulate design decisions"}},
      {"name": "extension_ability", "weight": 20, "description": "Can extend the agent with new capabilities", "scoring_guide": {"high": "Successfully adds a new capability and explains the change", "medium": "Adds capability with help", "low": "Cannot extend the agent"}}
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
 'Create a working buyer agent that discovers products, executes media buys, and syncs creatives. Use any AI coding assistant with the adcp client library. The skill tested is orchestrating a buying workflow correctly.',
 'capstone', 45, 4, false, '{C3}',
 '{
    "objectives": [
      "Specify a buying workflow in AdCP terms for a coding assistant to build",
      "Validate the buyer agent''s orchestration against sandbox sellers",
      "Explain orchestration decisions and trade-offs",
      "Extend the agent with new buying capabilities"
    ],
    "key_concepts": [
      {"topic": "Phase 1: Specify (~5 min)", "teaching_notes": "Help the learner craft a prompt for their coding assistant. They represent a fictional brand: what''s the brand? What''s the budget? Who''s the audience? What channels? What are the campaign goals? The prompt should describe the buying workflow: discover products from sellers, compare, allocate budget, buy, sync creatives. This tests whether they can translate C1-C3 knowledge into a specification. Do NOT write the prompt for them."},
      {"topic": "Phase 2: Build (~5 min)", "teaching_notes": "The learner builds the buyer agent with their coding assistant and the adcp client library. The agent should connect to @cptestagent (or any sandbox agent) for testing. Tell them to come back when it''s running and has executed at least one buy."},
      {"topic": "Phase 3: Validate (~10 min)", "teaching_notes": "Give specific test scenarios: (1) Run get_products against @cptestagent and paste the discovery results — does the agent correctly parse products? (2) Show the create_media_buy request and response — is the schema correct? Does it include targeting? (3) Try a buy with budget below the seller''s minimum — how does it handle the error? (4) Run sync_creatives — did it pick an appropriate format? Validate each pasted response against schemas."},
      {"topic": "Phase 4: Explain (~10 min)", "teaching_notes": "Probing questions: How did you decide which products to buy? If you had 3 sellers instead of 1, how would you allocate budget? What''s the difference between proposal mode and manual mode? How would you add audience targeting with sync_audiences? What happens if the seller rejects your creative? The learner should reason about buying strategy, not just describe what the agent does."},
      {"topic": "Phase 5: Extend (~15 min)", "teaching_notes": "Challenge: (1) Add sync_audiences to target a custom audience segment. (2) Add get_media_buy_delivery to monitor campaign performance. (3) Add update_media_buy to adjust the campaign based on delivery data. They go back to the coding assistant, make changes, come back with results. This tests iteration on a buying workflow."}
    ]
  }',
 '[
    {
      "id": "c4_specify",
      "title": "Specify your buyer agent",
      "description": "Choose a brand scenario and describe the buying workflow — budget, audience, channels, campaign goals — using AdCP terminology.",
      "sandbox_actions": [],
      "success_criteria": [
        "Learner describes a brand with specific goals and budget",
        "Buying workflow covers discovery, purchase, and creative sync",
        "Specification uses correct AdCP task names and concepts"
      ]
    },
    {
      "id": "c4_validate",
      "title": "Validate your buyer agent",
      "description": "Run the buying workflow against sandbox sellers and paste results. Addie validates schema compliance, orchestration logic, and error handling.",
      "sandbox_actions": [
        {"tool": "get_products", "guidance": "Learner pastes product discovery results. Check that the agent parses and evaluates products correctly."},
        {"tool": "create_media_buy", "guidance": "Learner pastes the buy request/response. Validate schema, targeting, and budget."},
        {"tool": "sync_creatives", "guidance": "Learner shows creative sync results. Check format matching."}
      ],
      "success_criteria": [
        "Agent successfully discovers products from sandbox sellers",
        "Media buy request is schema-compliant with targeting and budget",
        "Creative sync picks an appropriate format",
        "Error cases (bad budget, unavailable product) handled gracefully"
      ]
    },
    {
      "id": "c4_extend",
      "title": "Extend your buyer agent",
      "description": "Add audience targeting, delivery monitoring, or campaign optimization. Explain the changes and show results.",
      "sandbox_actions": [
        {"tool": "sync_audiences", "guidance": "If they added audience targeting, validate the sync request."},
        {"tool": "get_media_buy_delivery", "guidance": "If they added delivery monitoring, validate the response."}
      ],
      "success_criteria": [
        "Agent has a new capability beyond the original build",
        "New requests/responses pass schema validation",
        "Learner explains what they added and why it matters for the campaign"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "specification_quality", "weight": 20, "description": "Can specify a buying workflow in AdCP terms", "scoring_guide": {"high": "Describes brand, budget, audience, and workflow using correct AdCP terminology", "medium": "Needs prompting to use correct terms", "low": "Cannot describe buying requirements in AdCP terms"}},
      {"name": "schema_compliance", "weight": 25, "description": "Agent requests and responses validate against schemas", "scoring_guide": {"high": "All requests and responses pass schema validation", "medium": "Most valid with minor issues", "low": "Fails schema validation"}},
      {"name": "error_handling", "weight": 15, "description": "Handles seller errors and async responses", "scoring_guide": {"high": "Handles async responses, error codes, and edge cases", "medium": "Handles some cases", "low": "Breaks on unexpected responses"}},
      {"name": "design_rationale", "weight": 20, "description": "Can explain orchestration and buying strategy", "scoring_guide": {"high": "Clear rationale for product selection, budget allocation, and audience strategy", "medium": "Can explain basics but not trade-offs", "low": "Cannot articulate buying decisions"}},
      {"name": "extension_ability", "weight": 20, "description": "Can extend the agent with new buying capabilities", "scoring_guide": {"high": "Successfully adds audience targeting or delivery monitoring and explains why", "medium": "Adds capability with help", "low": "Cannot extend the agent"}}
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
 'Build a working AdCP endpoint that handles real protocol flows. Use any AI coding assistant with the adcp client library. The most ambitious build project — full protocol implementation.',
 'capstone', 45, 4, false, '{D3}',
 '{
    "objectives": [
      "Specify AdCP infrastructure requirements for a coding assistant to build",
      "Validate protocol compliance across multiple AdCP tasks",
      "Reason about production concerns: scaling, auth, concurrency",
      "Extend the endpoint with advanced protocol features"
    ],
    "key_concepts": [
      {"topic": "Phase 1: Specify (~5 min)", "teaching_notes": "Help the learner choose a platform scenario and describe it in AdCP terms. Two paths: (1) publisher-side MCP server — regional publisher, niche content network, event platform — handling get_products, create_media_buy, delivery. (2) Intermediary — ad exchange, measurement aggregator, data enrichment proxy. The prompt should specify which AdCP tasks to implement, what transport to use (Streamable HTTP), and how get_adcp_capabilities should describe the platform. This is the most ambitious build project — the specification matters."},
      {"topic": "Phase 2: Build (~5 min)", "teaching_notes": "The learner builds with their coding assistant and adcp client library. get_adcp_capabilities is non-negotiable — it''s how other agents discover the platform. Tell them to come back when it''s running and responding to capability queries."},
      {"topic": "Phase 3: Validate (~10 min)", "teaching_notes": "Rigorous testing: (1) get_adcp_capabilities — does it accurately describe what the platform supports? (2) Main protocol tasks — paste responses, validate schemas. (3) Error cases — what happens with malformed requests? Missing auth? Invalid task parameters? (4) Check that error responses include recovery_type (transient/correctable/terminal). This is infrastructure — error handling isn''t optional."},
      {"topic": "Phase 4: Explain (~10 min)", "teaching_notes": "Architecture conversation: How would you deploy this? What happens with 100 concurrent buyers? How does agent authentication work — walk me through the OAuth flow. If a create_media_buy takes 30 seconds to process, how do you handle async? How would you add webhook delivery for status updates? What''s in your adagents.json? The learner should think like a platform engineer."},
      {"topic": "Phase 5: Extend (~15 min)", "teaching_notes": "Challenge: (1) Add a task that wasn''t in the original build — sync_accounts for buyer onboarding, or get_media_buy_delivery for reporting. (2) Add proper async response handling — return working status and a task_id, then resolve. (3) Add input validation that returns specific AdCP error codes. They iterate with the coding assistant and come back with results."}
    ]
  }',
 '[
    {
      "id": "d4_specify",
      "title": "Specify your AdCP infrastructure",
      "description": "Choose a platform scenario (publisher server, exchange, data proxy) and describe what tasks it handles and how it advertises capabilities.",
      "sandbox_actions": [],
      "success_criteria": [
        "Learner describes a clear platform scenario with specific AdCP tasks",
        "Specification includes get_adcp_capabilities with accurate capability set",
        "Transport and auth approach described"
      ]
    },
    {
      "id": "d4_validate",
      "title": "Validate your endpoint",
      "description": "Run protocol flows against your local endpoint and paste results. Addie validates schema compliance, capability advertisement, and error handling.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "Learner pastes capability response. Validate it accurately describes the platform."},
        {"tool": "get_products", "guidance": "Learner pastes product responses (if publisher-side). Full schema validation."},
        {"tool": "create_media_buy", "guidance": "Test with valid and invalid requests. Check async handling and error codes."}
      ],
      "success_criteria": [
        "get_adcp_capabilities returns accurate, schema-compliant capabilities",
        "At least 3 AdCP tasks respond with valid schemas",
        "Error responses include recovery_type and meaningful messages",
        "Async patterns handled correctly (working status with task_id)"
      ]
    },
    {
      "id": "d4_extend",
      "title": "Extend your endpoint",
      "description": "Add a new task, async handling, or input validation. Show results and explain the architecture impact.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "Re-check capabilities after extension — does it reflect the new task?"},
        {"tool": "sync_accounts", "guidance": "If they added account management, validate the flow."}
      ],
      "success_criteria": [
        "Endpoint has a new capability not in the original build",
        "get_adcp_capabilities updated to reflect the addition",
        "Learner explains how the extension affects the platform architecture"
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "specification_quality", "weight": 20, "description": "Can specify infrastructure in AdCP terms", "scoring_guide": {"high": "Clear platform scenario with specific tasks, transport, and auth approach", "medium": "Needs prompting to be specific", "low": "Cannot describe infrastructure requirements"}},
      {"name": "schema_compliance", "weight": 20, "description": "Protocol compliance across all endpoints", "scoring_guide": {"high": "All responses pass schema validation including capabilities", "medium": "Most responses valid", "low": "Schema violations"}},
      {"name": "error_handling", "weight": 15, "description": "Proper error handling with recovery types and async", "scoring_guide": {"high": "Full async patterns, error recovery types, and meaningful error messages", "medium": "Basic error handling", "low": "Crashes on errors"}},
      {"name": "design_rationale", "weight": 25, "description": "Can reason about production architecture", "scoring_guide": {"high": "Explains scaling, concurrency, auth, and deployment strategy", "medium": "Can explain basics", "low": "Cannot articulate architecture decisions"}},
      {"name": "extension_ability", "weight": 20, "description": "Can extend the endpoint with new tasks", "scoring_guide": {"high": "Adds a new task, updates capabilities, and explains the impact", "medium": "Adds capability with help", "low": "Cannot extend the endpoint"}}
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

-- S1: Media buy mastery (prerequisite: A3, not A5)
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S1', 'S', 'Media buy mastery',
 'Full media buy lifecycle across all tasks. Proposals, delivery forecasting, refinement, package management, optimization goals, keyword targeting, and geo-proximity.',
 'capstone', 45, 1, false, '{A3}',
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

-- S2: Creative mastery (prerequisite: A3)
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S2', 'S', 'Creative mastery',
 'Full creative protocol from format design through compliance. 19 channels, creative manifest, AI-powered generation, disclosure requirements, and creative feature evaluation.',
 'capstone', 45, 2, false, '{A3}',
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

-- S3: Signals and audiences (prerequisite: A3)
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S3', 'S', 'Signals and audiences',
 'Audience data activation, privacy, and measurement infrastructure. Signal discovery, pricing, activation/deactivation for GDPR compliance, conversion tracking, and attribution.',
 'capstone', 45, 3, false, '{A3}',
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

-- S4: Governance and brand safety (prerequisite: A3)
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S4', 'S', 'Governance and brand safety',
 'Content standards, property governance, and AI-driven brand safety. The Oracle model, creative feature evaluation, compliance artifacts, and property authorization at scale.',
 'capstone', 45, 4, false, '{A3}',
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

-- S5: Sponsored Intelligence (prerequisite: A3)
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('S5', 'S', 'Sponsored Intelligence',
 'Conversational brand experiences in AI assistants. Session lifecycle, A2UI component rendering, offering discovery, and the shift from impressions to conversations.',
 'capstone', 45, 5, false, '{A3}',
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

-- Basics: A1 + A2 + A3 (all free)
UPDATE certification_credentials SET
  description = 'Used the protocol, executed a media buy, and toured the full AdCP landscape. Free and open to everyone.',
  required_modules = '{A1,A2,A3}'
WHERE id = 'basics';

-- Practitioner: Basics + 1 complete role track (tracks handle the rest)
UPDATE certification_credentials SET
  description = 'Created a working AdCP integration through a hands-on build project. Comprehensive protocol knowledge with demonstrated ability to build.',
  required_modules = '{A1,A2,A3}'
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

-- Update badge descriptions
UPDATE badges SET
  description = 'Completed AdCP basics — used the protocol, executed a media buy, toured the landscape'
WHERE id = 'adcp_basics';

UPDATE badges SET
  description = 'Created a working AdCP integration through hands-on build project with interactive exercises'
WHERE id = 'adcp_practitioner';

-- =====================================================
-- CLEANUP
-- =====================================================

-- Remove A4 and A5 if they exist (content absorbed into A3 survey + role tracks)
-- First migrate any progress
UPDATE learner_progress SET module_id = 'A3' WHERE module_id IN ('A4', 'A5');
DELETE FROM certification_modules WHERE id IN ('A4', 'A5');

-- Clean up: remove E track if no modules reference it
DELETE FROM certification_tracks WHERE id = 'E'
  AND NOT EXISTS (SELECT 1 FROM certification_modules WHERE track_id = 'E');
