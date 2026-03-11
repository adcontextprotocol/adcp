-- Fix A3 module: change "9 protocol domains" to "8 protocol domains"
-- to match the actual count in docs/intro.mdx (8 domains: Accounts, Media Buy,
-- Creative, Signals, Governance, Sponsored Intelligence, Brand Protocol, Registry)
-- Also restores lesson_plan that was accidentally nulled.

UPDATE certification_modules SET
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
      {"name": "curiosity", "weight": 15, "description": "Shows interest in going deeper on at least one area", "scoring_guide": {"high": "Asks insightful follow-up questions about a specific domain", "medium": "Shows some interest", "low": "Passive engagement"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A3';
