-- Migration: Replace fact-duplicating key_concepts with teaching guidance
--
-- Problem: key_concepts contained protocol facts (e.g., "AdCP is built on MCP")
-- that duplicated documentation and went stale. Addie parroted these verbatim.
--
-- Fix: key_concepts now contain teaching guidance — what to cover, what to
-- emphasize, and which docs to reference. The documentation is the single
-- source of truth for protocol facts; the seed is the source of truth for
-- *how to teach* those facts.

-- A1: Agentic advertising fundamentals
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Agentic vs traditional programmatic", "teaching_notes": "Help the learner contrast rigid API-driven programmatic with goal-driven autonomous agents. Use concrete examples: instead of configuring bid parameters, you describe campaign goals. Reference the protocol comparison doc for detailed differences."},
    {"topic": "AI agents in advertising", "teaching_notes": "Define what an agent is (perceive, decide, act) and map those capabilities to advertising tasks — discovering inventory, negotiating, managing creatives, optimizing campaigns. Emphasize autonomy and reasoning, not just automation."},
    {"topic": "The AdCP standard", "teaching_notes": "Explain why a shared protocol matters — without it, every platform needs custom integrations. AdCP provides the shared language. Reference the intro docs for the fragmentation problem AdCP solves."},
    {"topic": "Protocol transports", "teaching_notes": "Cover the transport layer — how agents connect and communicate. AdCP supports multiple transports including MCP and A2A. Reference the MCP guide and A2A guide in the integration docs for specifics. Do NOT claim AdCP is built on only one transport."}
  ]'::jsonb
) WHERE id = 'A1';

-- A2: AdCP architecture and protocol overview
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "The AdCP stack", "teaching_notes": "Walk through the layers: transports (MCP, A2A — how agents connect), AdCP tasks (what agents can do — get_products, create_media_buy, sync_creatives), and the agent ecosystem (who builds and runs agents). Reference the quickstart for a concrete code example."},
    {"topic": "Agent roles", "teaching_notes": "Cover the main agent roles: sales agents (publishers), buyer agents (brands/agencies), brand agents (identity/guidelines), creative agents (asset production), signals agents (measurement). Let the learner discover these through get_products demos."},
    {"topic": "Tool discovery", "teaching_notes": "Explain adagents.json as the agent discovery mechanism — like robots.txt for agents. A buyer agent reads this to learn what a sales agent offers. Reference the accounts-and-agents doc for the full discovery flow."},
    {"topic": "The transaction flow", "teaching_notes": "Walk through: Discovery (get_products) → Selection → Purchase (create_media_buy) → Creative (sync_creatives) → Measurement (get_signals). Use a demo scenario to make it concrete. Reference the quickstart for the code flow."}
  ]'::jsonb
) WHERE id = 'A2';

-- A3: AgenticAdvertising.org ecosystem and governance
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Governance structure", "teaching_notes": "Explain that AgenticAdvertising.org is member-driven. Cover working groups (develop spec areas), industry councils (practitioner input), and the RFC/consensus process. Reference the governance overview doc."},
    {"topic": "Specification development", "teaching_notes": "Cover semantic versioning, the proposal-to-ratification flow, and what constitutes breaking vs. non-breaking changes. Emphasize the open-source, transparent process."},
    {"topic": "Relationship to existing standards", "teaching_notes": "AdCP complements (not replaces) existing standards. Cover the relationship with OpenRTB, IAB taxonomies, and measurement standards. Reference the protocol comparison doc for a detailed breakdown."},
    {"topic": "Participation paths", "teaching_notes": "Cover how people can get involved: join working groups, attend councils, build agents, contribute to open-source. Make it actionable — the learner should know their next step."}
  ]'::jsonb
) WHERE id = 'A3';

-- B1: Building your sales agent
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Sales agent role", "teaching_notes": "Explain the sales agent as the publisher''s always-on representative. It handles get_products queries, describes inventory, processes media buys. Use the demo to show a real product catalog response."},
    {"topic": "Product catalog design", "teaching_notes": "Cover product structure: name, description, formats, pricing, targeting, availability. Emphasize that good catalog design makes discovery easy for buyer agents. Let the learner critique a real catalog from the sandbox."},
    {"topic": "Agent guardrails", "teaching_notes": "Publishers set boundaries: minimum CPMs, maximum discounts, acceptable categories. The agent operates autonomously within these. Ask the learner to design guardrails for different publisher types (premium vs. performance)."},
    {"topic": "Multi-agent scenarios", "teaching_notes": "Multiple buyers may query simultaneously. Discuss concurrency, inventory management, and prioritization. This is a good discussion topic — what happens when two agents want the same limited inventory?"}
  ]'::jsonb
) WHERE id = 'B1';

-- B2: Product discovery and creative specifications
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "get_products deep dive", "teaching_notes": "Walk through the get_products response schema in detail. Key fields: product name, description, format_types, targeting_options, pricing. Use sandbox demos to examine real responses. Reference the media buy task reference docs."},
    {"topic": "Creative format specifications", "teaching_notes": "Cover list_creative_formats — it returns exact specs for submitting creatives (dimensions, file types, max sizes, render requirements). This enables compliant asset production without back-and-forth. Reference the creative task reference docs."},
    {"topic": "Catalog optimization", "teaching_notes": "Discuss what makes a catalog AI-friendly: clear descriptions, logical grouping, complete targeting options, transparent pricing. Have the learner compare sandbox catalogs and suggest improvements."}
  ]'::jsonb
) WHERE id = 'B2';

-- B3: Measurement, reporting, and optimization
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Delivery reporting", "teaching_notes": "Cover get_media_buy_delivery: how buyers track impressions, spend, completion rates after a buy. Emphasize accuracy and timeliness. Use sandbox demo data to interpret real delivery reports."},
    {"topic": "Signals framework", "teaching_notes": "Explain signals as measurement data points (viewability, lift, conversions, reach). get_signals returns what''s available; activate_signal enables measurement. This replaces fragmented vendor integrations. Reference the signals protocol docs."},
    {"topic": "Optimization loop", "teaching_notes": "Connect delivery data + signals → buyer agent optimization. Agents can update_media_buy to adjust targeting, shift budget, change creative. Discuss how this continuous loop differs from manual optimization cycles."}
  ]'::jsonb
) WHERE id = 'B3';

-- C1: The buyer workflow and multi-agent orchestration
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Multi-agent buying", "teaching_notes": "A buyer agent queries multiple sales agents in parallel, compares options, and allocates budget. This replaces manual media planning. Use sandbox demos to query multiple agents and compare."},
    {"topic": "Orchestration pattern", "teaching_notes": "Walk through the five-step pattern: Discover → Evaluate → Allocate → Execute → Monitor. Have the learner trace through it with real sandbox tools. Reference the media buy protocol docs."},
    {"topic": "Cross-publisher measurement", "teaching_notes": "With buys across multiple publishers, aggregate reach, frequency, and performance must be measured. Discuss the challenges of deduplication and unified reporting across sellers."}
  ]'::jsonb
) WHERE id = 'C1';

-- C2: Brand identity and compliance protocols
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Brand identity protocol", "teaching_notes": "Cover brand.json (at /.well-known/adcp/brand.json) — declares brand identity (name, logos, colors, guidelines). Brand agents use it to keep all advertising on-brand. Reference the brand protocol docs."},
    {"topic": "Brand compliance", "teaching_notes": "Cover the full compliance landscape: brand standards protocol (MCP-based compliance checking), creative policy (what creatives are acceptable), and governance tools (property lists, content standards). Do NOT present this as only brand safety — it includes creative governance too. Reference both the brand protocol and governance docs."},
    {"topic": "Supply chain preferences", "teaching_notes": "Brands specify suitability (appropriate contexts), safety (must-avoid), and sustainability (environmental/social). These propagate through the buying chain. Have the learner design preferences for a hypothetical brand."}
  ]'::jsonb
) WHERE id = 'C2';

-- C3: Creative workflows and sponsored intelligence
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Creative lifecycle", "teaching_notes": "Walk through: build_creative → preview_creative → sync_creatives. Creative agents produce assets based on brand guidelines and format specs. They adapt across display, video, audio, native. Use sandbox demos. Reference creative protocol docs."},
    {"topic": "Cross-platform adaptation", "teaching_notes": "A creative agent takes brand assets and adapts for each publisher''s format requirements. Discuss how this replaces manual resizing/reformatting while respecting both brand guidelines and publisher specs."},
    {"topic": "Sponsored Intelligence Protocol", "teaching_notes": "Cover SI as a distinct protocol for conversational AI placements. Brands participate in AI assistant experiences with transparency and user control. Reference the SI docs. Let the learner connect to a sandbox SI agent."}
  ]'::jsonb
) WHERE id = 'C3';

-- D1: Implementing AdCP: MCP server architecture
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "MCP server fundamentals", "teaching_notes": "Cover MCP server architecture: tool registration, request routing, authentication. Reference the MCP integration guide. Emphasize that MCP is one of the supported transports — also cover A2A for agent-to-agent communication."},
    {"topic": "Transport options", "teaching_notes": "Streamable HTTP is the primary MCP transport. SSE for real-time updates. A2A provides an alternative transport for agent-to-agent workflows. Cover when to use each. Reference both the MCP guide and A2A guide."},
    {"topic": "Authorization and trust", "teaching_notes": "Cover OAuth 2.0 for agent authentication — tokens, permissions, access control. This enables trust between agents from different organizations. Reference the accounts-and-agents doc."}
  ]'::jsonb
) WHERE id = 'D1';

-- D2: Supply path and agent trust
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Agent identity verification", "teaching_notes": "Cover adagents.json as the identity mechanism — domain ownership, cryptographic signatures, organizational registration. Use sandbox demos to validate an agent''s identity."},
    {"topic": "Supply path transparency", "teaching_notes": "AdCP provides full visibility into the supply path — which agents handled a transaction, what decisions were made. Contrast this with opaque traditional supply chains. Use the supply path audit exercise."},
    {"topic": "Relationship to ads.cert", "teaching_notes": "ads.cert provides cryptographic verification for RTB. AdCP extends this concept to agent-to-agent interactions. Reference the A2A guide for how agent trust works in practice."}
  ]'::jsonb
) WHERE id = 'D2';

-- D3: RTB migration patterns
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Coexistence strategy", "teaching_notes": "AdCP doesn''t require replacing RTB overnight. Platforms can run both in parallel. An AdCP agent can generate RTB bid requests when needed. Reference the protocol comparison doc for how the two paradigms relate."},
    {"topic": "Platform-specific migration", "teaching_notes": "Cover entry points for each platform type: DSPs (wrap bidding logic in buyer agent), SSPs (expose inventory through sales agent), Exchanges (build intermediary agents). Each has different starting points and challenges."},
    {"topic": "Performance benchmarking", "teaching_notes": "During parallel running, measure campaign performance, operational efficiency, cost, and quality (brand safety, viewability). Use data to justify deeper migration. Have the learner design a benchmarking plan."}
  ]'::jsonb
) WHERE id = 'D3';

-- E1: Capstone: Media buy
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Transaction lifecycle", "teaching_notes": "Cover the full flow: discover products → evaluate → create media buy → monitor delivery → adjust. Each step has protocol patterns and failure modes. Use sandbox tools to execute the full lifecycle."},
    {"topic": "Multi-agent orchestration", "teaching_notes": "Have the learner query multiple sellers, compare, and allocate budget. This is a hands-on capstone — they should demonstrate the complete orchestration pattern, not just describe it."},
    {"topic": "Pricing and negotiation", "teaching_notes": "Cover pricing models (CPM, flat rate, hybrid), minimum spend, availability windows. The learner should evaluate these against campaign goals and make informed decisions using real sandbox data."},
    {"topic": "Delivery and reconciliation", "teaching_notes": "Use get_media_buy_delivery to track real delivery data. Have the learner diagnose issues — was targeting too narrow? Budget too low? Creative rejected? Emphasize diagnostic reasoning."}
  ]'::jsonb
) WHERE id = 'E1';

-- E2: Capstone: Creative
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Creative lifecycle", "teaching_notes": "Walk through: list_creative_formats → build_creative → preview_creative → sync_creatives. The learner should execute each step against sandbox agents. Reference creative protocol docs for schema details."},
    {"topic": "Format compliance", "teaching_notes": "Each publisher specifies exact requirements (dimensions, file types, max sizes). Non-compliant creatives get rejected. Have the learner intentionally trigger a rejection and diagnose it."},
    {"topic": "Cross-platform adaptation", "teaching_notes": "A single concept must render across display, video, native, audio. Discuss how creative agents handle this while maintaining brand consistency. Have the learner adapt a concept for multiple formats."},
    {"topic": "Brand consistency", "teaching_notes": "Creative agents reference brand.json for guidelines. All generated assets must be on-brand. Discuss the relationship between brand protocol and creative protocol — they work together."}
  ]'::jsonb
) WHERE id = 'E2';

-- E3: Capstone: Signals
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Signals framework", "teaching_notes": "Cover signal types: viewability, brand lift, conversions, attention, reach. Use get_signals to discover what''s available from sandbox agents. Reference the signals protocol docs."},
    {"topic": "Measurement activation", "teaching_notes": "Not all signals are active by default. Buyer agents selectively activate based on objectives. Premium signals may cost extra. Have the learner choose signals for different campaign types and justify their choices."},
    {"topic": "Attribution and optimization", "teaching_notes": "Signal data feeds back into campaign optimization — adjusting targeting, budgets, creative rotation. Have the learner design an optimization loop using real signal data."},
    {"topic": "Cross-publisher measurement", "teaching_notes": "Aggregating signals across publishers is challenging — frequency management, reach deduplication, cross-platform attribution. Discuss these as open problems the learner should understand."}
  ]'::jsonb
) WHERE id = 'E3';

-- E4: Capstone: Governance
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  '[
    {"topic": "Governance overview", "teaching_notes": "Cover the full governance landscape: property lists, content standards, creative policy, and brand safety calibration. Governance is broader than just brand safety — it includes content moderation, creative compliance, and supply chain controls. Reference the governance protocol docs."},
    {"topic": "Property lists", "teaching_notes": "Property lists define included/excluded publisher domains/apps. create_property_list and update_property_list manage these. Have the learner create lists for different brand risk profiles."},
    {"topic": "Content standards and calibration", "teaching_notes": "Content standards define acceptable adjacent content. calibrate_content evaluates content against those standards in real time. Have the learner create standards and test content against them using sandbox tools."},
    {"topic": "Compliance automation", "teaching_notes": "Property lists + content standards + creative policy + calibration create an automated compliance framework. Agents continuously evaluate and enforce rules. Discuss how this replaces manual review processes."}
  ]'::jsonb
) WHERE id = 'E4';
