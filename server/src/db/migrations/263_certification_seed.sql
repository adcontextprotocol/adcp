-- Seed certification tracks and modules from the AdCP Certification Curriculum
-- Certifier group IDs are placeholders — set real values after creating groups in Certifier dashboard

-- =====================================================
-- TRACKS
-- =====================================================

INSERT INTO certification_tracks (id, name, description, badge_type, certifier_group_id, sort_order) VALUES
  ('A', 'Foundations', 'Required for all learners. Covers why agentic advertising matters, AdCP architecture, and the AgenticAdvertising.org ecosystem.', NULL, NULL, 1),
  ('B', 'Publisher / Seller path', 'Build and operate an AdCP sales agent. Product catalog design, creative specifications, measurement, and reporting.', 'publisher', NULL, 2),
  ('C', 'Buyer / Brand path', 'Orchestrate multi-agent buying workflows. Brand identity protocols, creative workflows, and sponsored intelligence.', 'buyer', NULL, 3),
  ('D', 'Platform / Intermediary path', 'Build AdCP infrastructure. MCP server architecture, supply path and agent trust, RTB migration patterns.', 'platform', NULL, 4),
  ('E', 'Specialist capstones', 'Protocol-specific capstone modules combining hands-on lab and adaptive exam. Each covers a core AdCP protocol area: media buy, creative, signals, or governance.', NULL, NULL, 5)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  badge_type = EXCLUDED.badge_type,
  sort_order = EXCLUDED.sort_order;

-- =====================================================
-- MODULES — Track A: Foundations (required for all)
-- =====================================================

INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES

('A1', 'A', 'Welcome and why agentic advertising',
 'Explore the difference between agentic buying and traditional programmatic. Understand what AI agents are, why they matter for advertising, and how AdCP fits into this world.',
 'interactive', 12, 1, true, '{}',
 '{
   "objectives": [
     "Explain the difference between agentic and traditional programmatic advertising",
     "Describe what AI agents are in the context of media buying",
     "Articulate why AdCP exists and the problem it solves"
   ],
   "key_concepts": [
     {"topic": "Agentic vs traditional programmatic", "explanation": "Traditional programmatic uses rigid APIs with fixed parameters. Agentic advertising uses AI agents that can reason, negotiate, and adapt. Instead of configuring a DSP, you tell an agent your goals and it figures out how to achieve them."},
     {"topic": "AI agents in advertising", "explanation": "An AI agent is software that can perceive its environment, make decisions, and take actions autonomously. In advertising, agents can discover inventory, negotiate pricing, manage creatives, and optimize campaigns — tasks that previously required human traders."},
     {"topic": "The AdCP standard", "explanation": "The Advertising Context Protocol (AdCP) is an open standard that lets AI agents from different companies work together. Without it, every platform would need custom integrations. AdCP provides a shared language for media buying."},
     {"topic": "The protocol hierarchy", "explanation": "AdCP is built on MCP (Model Context Protocol). MCP handles the transport layer — how agents connect and communicate. AdCP adds the advertising domain — what agents can say to each other about media buying."}
   ],
   "discussion_prompts": [
     "Can you explain in your own words what makes an AI agent different from a traditional API?",
     "Why do you think a shared protocol matters for AI-powered advertising?",
     "What problems might arise if every ad tech company built their own agent protocol?"
   ]
 }',
 NULL,
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 30, "description": "Understands agentic vs traditional paradigm", "scoring_guide": {"high": "Can articulate the paradigm shift clearly", "medium": "Understands the difference but misses nuances", "low": "Confuses agents with traditional APIs"}},
     {"name": "practical_knowledge", "weight": 20, "description": "Can relate concepts to real scenarios", "scoring_guide": {"high": "Gives concrete examples", "medium": "Understands in abstract", "low": "Cannot connect to practice"}},
     {"name": "communication_clarity", "weight": 25, "description": "Explains concepts clearly", "scoring_guide": {"high": "Clear, concise explanations", "medium": "Mostly clear with some vagueness", "low": "Confusing or circular explanations"}},
     {"name": "protocol_fluency", "weight": 25, "description": "Uses AdCP terminology correctly", "scoring_guide": {"high": "Correctly uses terms like MCP, agent, protocol", "medium": "Mostly correct", "low": "Misuses terminology"}}
   ],
   "passing_threshold": 70
 }'),

('A2', 'A', 'AdCP architecture and protocol overview',
 'Walk through the AdCP stack: MCP transport layer, tool discovery, sales agents, buyer agents, brand agents. See a live demo of agents trading.',
 'interactive', 15, 2, true, '{A1}',
 '{
   "objectives": [
     "Describe the MCP transport layer and how agents connect",
     "List the main agent roles in AdCP (sales agent, buyer agent, brand agent, creative agent, signals agent)",
     "Understand the tool discovery flow: how a buyer agent finds a seller''s products",
     "Observe a live agent-to-agent transaction"
   ],
   "key_concepts": [
     {"topic": "The AdCP stack", "explanation": "AdCP has layers: MCP (transport — how agents connect), AdCP tasks (what agents can do — get_products, create_media_buy, sync_creatives), and the agent ecosystem (who builds and runs agents)."},
     {"topic": "Agent roles", "explanation": "Sales agents represent publishers and expose inventory. Buyer agents represent brands/agencies and purchase media. Brand agents manage brand identity and guidelines. Creative agents handle asset production. Signals agents provide measurement and audience data."},
     {"topic": "Tool discovery", "explanation": "An agent advertises its capabilities through adagents.json (like robots.txt for agents). A buyer agent reads this to discover what a sales agent can do — what products are available, what creative formats are supported, etc."},
     {"topic": "The transaction flow", "explanation": "Discovery (get_products) → Selection (choose products/formats) → Purchase (create_media_buy) → Creative (sync_creatives) → Measurement (get_signals). Each step is an AdCP task executed via MCP tool calls."}
   ],
   "discussion_prompts": [
     "Walk me through what happens when a buyer agent wants to purchase a CTV ad from a publisher. What are the steps?",
     "What role does adagents.json play? Why is it important for the ecosystem?",
     "How does the MCP layer relate to the AdCP layer? What does each handle?"
   ],
   "demo_scenarios": [
     {"description": "Discover products from a sandbox sales agent", "tools": ["get_products"], "expected_outcome": "See real product catalog with formats, pricing, and targeting options"},
     {"description": "Show the buyer-to-seller transaction flow", "tools": ["get_products", "create_media_buy"], "expected_outcome": "Complete a mock media buy demonstrating the full protocol flow"}
   ]
 }',
 '[
   {
     "id": "a2_ex1",
     "title": "Agent discovery",
     "description": "Use get_products to query a sandbox sales agent and examine the response structure.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Call get_products against a sandbox agent. Examine the product catalog, formats, and pricing."}
     ],
     "success_criteria": [
       "Successfully calls get_products and receives a product catalog",
       "Can identify the key fields in the response (products, formats, pricing)"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands the protocol stack and agent roles", "scoring_guide": {"high": "Can explain each layer and role", "medium": "Gets most roles right", "low": "Confuses roles or layers"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Can trace through a transaction flow", "scoring_guide": {"high": "Accurately describes the full flow", "medium": "Gets main steps right", "low": "Misses key steps"}},
     {"name": "problem_solving", "weight": 15, "description": "Can reason about what happens when things go wrong", "scoring_guide": {"high": "Identifies failure points and recovery", "medium": "Identifies some issues", "low": "Cannot reason about failures"}},
     {"name": "protocol_fluency", "weight": 30, "description": "Correctly names tasks, agents, and concepts", "scoring_guide": {"high": "Uses correct task names and agent roles", "medium": "Mostly correct", "low": "Frequently misnames things"}}
   ],
   "passing_threshold": 70
 }'),

('A3', 'A', 'AgenticAdvertising.org ecosystem and governance',
 'How AgenticAdvertising.org works: working groups, industry councils, the spec development process. How AdCP relates to OpenRTB, AAMP, and existing IAB standards.',
 'interactive', 18, 3, true, '{A2}',
 '{
   "objectives": [
     "Describe AgenticAdvertising.org''s governance structure",
     "Understand how the specification is developed and versioned",
     "Explain the relationship between AdCP and existing ad tech standards",
     "Know how to participate in the ecosystem"
   ],
   "key_concepts": [
     {"topic": "Governance structure", "explanation": "AgenticAdvertising.org is a member-driven organization. Working groups develop specific parts of the spec (e.g., Signals Working Group, Creative Working Group). Industry councils bring together practitioners. The spec evolves through RFCs and community consensus."},
     {"topic": "Specification development", "explanation": "The AdCP spec uses semantic versioning. Changes go through proposal → working group review → community feedback → ratification. Breaking changes require a major version bump. The process is open-source and transparent."},
     {"topic": "Relationship to existing standards", "explanation": "AdCP doesn''t replace OpenRTB — it complements it. OpenRTB handles real-time bidding; AdCP handles agent-to-agent workflows. They can coexist, with AdCP agents generating RTB bid requests when needed. AdCP also builds on IAB standards for taxonomy, viewability, and measurement."},
     {"topic": "Participation paths", "explanation": "Join a working group to help develop the spec. Attend industry councils to share use cases. Build and register an agent to participate in the ecosystem. Contribute to open-source reference implementations."}
   ],
   "discussion_prompts": [
     "How does a new feature get added to the AdCP specification?",
     "If a publisher already uses OpenRTB, how does AdCP fit in?",
     "What are the benefits of participating in AgenticAdvertising.org?"
   ]
 }',
 NULL,
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 30, "description": "Understands governance and spec process", "scoring_guide": {"high": "Accurately describes the process", "medium": "General understanding", "low": "Confused about governance"}},
     {"name": "practical_knowledge", "weight": 25, "description": "Knows how to participate", "scoring_guide": {"high": "Can describe specific participation paths", "medium": "Knows some paths", "low": "Unclear on how to participate"}},
     {"name": "communication_clarity", "weight": 20, "description": "Can explain the ecosystem clearly", "scoring_guide": {"high": "Clear and organized", "medium": "Mostly clear", "low": "Disorganized"}},
     {"name": "protocol_fluency", "weight": 25, "description": "Understands AdCP''s relationship to other standards", "scoring_guide": {"high": "Accurately describes relationships", "medium": "Gets the general idea", "low": "Confuses standards"}}
   ],
   "passing_threshold": 70
 }')
ON CONFLICT (id) DO UPDATE SET
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
-- MODULES — Track B: Publisher / Seller path
-- =====================================================

INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES

('B1', 'B', 'Building your sales agent',
 'How a hosted sales agent works: product discovery, audience targeting, pricing. Walkthrough of the Hosted Sales Agent Builder and how to define your product catalog.',
 'interactive', 15, 1, false, '{A3}',
 '{
   "objectives": [
     "Understand what a sales agent does and how it represents publisher inventory",
     "Know the key components: product catalog, pricing models, targeting parameters, agent guardrails",
     "Walk through configuring a sales agent with real tools"
   ],
   "key_concepts": [
     {"topic": "Sales agent role", "explanation": "A sales agent is the publisher''s representative in AdCP. It responds to get_products queries from buyer agents, describes available inventory, negotiates pricing, and processes media buy orders. Think of it as an always-on, AI-powered sales team."},
     {"topic": "Product catalog design", "explanation": "Products represent available inventory. Each product has a name, description, formats (e.g., display_300x250, video_pre_roll), pricing (CPM, flat rate), targeting options, and availability. Good catalog design makes discovery easy for buyer agents."},
     {"topic": "Agent guardrails", "explanation": "Publishers set boundaries for what their sales agent can agree to: minimum CPMs, maximum discounts, required brand safety standards, acceptable content categories. The agent operates within these guardrails autonomously."},
     {"topic": "Multi-agent scenarios", "explanation": "Multiple buyer agents may query the same sales agent simultaneously. The agent handles concurrent requests, maintains inventory availability, and can prioritize based on publisher-defined rules."}
   ],
   "discussion_prompts": [
     "What makes a good product catalog structure? What should a buyer agent be able to learn from get_products?",
     "How would you design guardrails for a premium publisher vs. a performance-focused publisher?",
     "What happens when two buyer agents want the same inventory?"
   ],
   "demo_scenarios": [
     {"description": "Query a sandbox sales agent and explore its product catalog", "tools": ["get_products"], "expected_outcome": "See product structure with formats, pricing, and targeting"}
   ]
 }',
 '[
   {
     "id": "b1_ex1",
     "title": "Explore a sales agent",
     "description": "Query a partner sandbox sales agent using get_products and analyze the response.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Call get_products and examine the catalog structure — products, formats, pricing models, targeting options."}
     ],
     "success_criteria": [
       "Successfully queries a sandbox sales agent",
       "Can identify and explain the key product catalog fields"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands sales agent architecture", "scoring_guide": {"high": "Can explain how a sales agent represents inventory and enforces guardrails", "medium": "Understands the basic role but misses guardrail nuances", "low": "Confuses sales agent with traditional ad server"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Can design a product catalog", "scoring_guide": {"high": "Designs a clear catalog with formats, pricing, and targeting", "medium": "Creates a basic catalog but omits key fields", "low": "Cannot structure a product catalog"}},
     {"name": "problem_solving", "weight": 20, "description": "Can reason about multi-agent scenarios", "scoring_guide": {"high": "Identifies concurrency issues and prioritization strategies", "medium": "Recognizes multi-agent challenges at a high level", "low": "Cannot reason about concurrent buyer requests"}},
     {"name": "protocol_fluency", "weight": 25, "description": "Correct use of product/format terminology", "scoring_guide": {"high": "Uses get_products, format_types, and pricing model terms correctly", "medium": "Mostly correct with minor misuse", "low": "Frequently confuses product and format concepts"}}
   ],
   "passing_threshold": 70
 }'),

('B2', 'B', 'Product discovery and creative specifications',
 'Deep dive on get_products, list_creative_formats, and how buyer agents discover your inventory. Guide to structuring a product catalog and creative specs for maximum discoverability.',
 'interactive', 18, 2, false, '{B1}',
 '{
   "objectives": [
     "Understand the get_products response schema in detail",
     "Know how list_creative_formats works and why it matters",
     "Design a product catalog that buyer agents can easily evaluate",
     "Understand creative format specifications and renders"
   ],
   "key_concepts": [
     {"topic": "get_products deep dive", "explanation": "The get_products task returns a structured catalog. Key fields: product name, description, format_types (video, display, audio, native), targeting_options, pricing with min/max bounds, availability windows. Buyer agents use this to filter and select."},
     {"topic": "Creative format specifications", "explanation": "list_creative_formats returns the exact specifications for submitting creatives. Each format has dimensions, file types, max file sizes, and render requirements. This enables creative agents to produce compliant assets without back-and-forth."},
     {"topic": "Catalog optimization", "explanation": "A well-structured catalog groups products logically, provides clear descriptions for AI comprehension, includes all relevant targeting options, and specifies pricing transparently. Poor catalogs lead to missed opportunities."}
   ],
   "discussion_prompts": [
     "What makes a product catalog easy for an AI buyer agent to understand?",
     "How do creative format specifications prevent wasted creative production?",
     "What information should a product include to maximize match rates with buyer queries?"
   ],
   "demo_scenarios": [
     {"description": "Compare product catalogs from different sandbox agents", "tools": ["get_products", "list_creative_formats"], "expected_outcome": "Identify differences in catalog quality and completeness"}
   ]
 }',
 '[
   {
     "id": "b2_ex1",
     "title": "Product catalog evaluation",
     "description": "Query sandbox sales agents with get_products and evaluate catalog quality — completeness of descriptions, format coverage, and pricing transparency.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Query at least two sandbox agents. Compare their catalogs for structure, descriptions, format coverage, and pricing models."}
     ],
     "success_criteria": [
       "Successfully queries multiple sandbox agents",
       "Identifies differences in catalog quality and completeness",
       "Suggests specific improvements for weaker catalogs"
     ]
   },
   {
     "id": "b2_ex2",
     "title": "Creative format discovery",
     "description": "Use list_creative_formats to discover format specifications from a sandbox agent. Map formats back to products and identify which formats each product supports.",
     "sandbox_actions": [
       {"tool": "list_creative_formats", "guidance": "Query creative format specs. Examine dimensions, file types, and render requirements."},
       {"tool": "get_products", "guidance": "Cross-reference format specs with the product catalog to verify alignment."}
     ],
     "success_criteria": [
       "Successfully retrieves creative format specifications",
       "Can explain dimensions, file types, and render requirements",
       "Maps formats to products correctly"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands discovery and format specs", "scoring_guide": {"high": "Can explain get_products schema fields and list_creative_formats purpose in detail", "medium": "Understands discovery flow but misses format spec nuances", "low": "Confuses product discovery with creative format discovery"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Can evaluate and improve a product catalog", "scoring_guide": {"high": "Identifies catalog gaps and suggests improvements for AI comprehension", "medium": "Can evaluate a catalog but misses optimization opportunities", "low": "Cannot assess catalog quality"}},
     {"name": "problem_solving", "weight": 20, "description": "Can diagnose discovery issues", "scoring_guide": {"high": "Traces why a buyer agent might miss relevant inventory and proposes fixes", "medium": "Identifies basic discovery issues", "low": "Cannot reason about why products are not being discovered"}},
     {"name": "protocol_fluency", "weight": 25, "description": "Correct format/product terminology", "scoring_guide": {"high": "Correctly uses format_types, renders, dimensions, and pricing terms", "medium": "Mostly correct with occasional imprecision", "low": "Confuses format specifications with product attributes"}}
   ],
   "passing_threshold": 70
 }'),

('B3', 'B', 'Measurement, reporting, and optimization',
 'How to expose delivery data, measurement signals, and optimization levers through your sales agent. Integration with MxM platforms, lift testing, and attribution.',
 'interactive', 12, 3, false, '{B2}',
 '{
   "objectives": [
     "Understand get_media_buy_delivery and how buyers track campaign performance",
     "Know the signals framework: get_signals and activate_signal",
     "Understand attribution and optimization data flows"
   ],
   "key_concepts": [
     {"topic": "Delivery reporting", "explanation": "After a media buy is created, buyers need to track delivery — impressions, spend, completion rates. The get_media_buy_delivery task provides this. Sales agents should report accurately and promptly."},
     {"topic": "Signals framework", "explanation": "Signals are measurement data points: viewability, brand lift, conversions, audience reach. get_signals returns available signals. activate_signal enables specific measurement on a campaign. This replaces fragmented measurement integrations."},
     {"topic": "Optimization loop", "explanation": "Buyer agents use delivery data and signals to optimize. They may update_media_buy to adjust targeting, shift budget, or change creative. The seller agent processes these updates within its guardrails."}
   ],
   "discussion_prompts": [
     "What delivery metrics should a sales agent expose? How frequently?",
     "How do signals replace traditional measurement vendor integrations?",
     "What role does the optimization loop play in campaign performance?"
   ]
 }',
 '[
   {
     "id": "b3_ex1",
     "title": "Delivery data analysis",
     "description": "Retrieve delivery data from a sandbox campaign and analyze pacing, spend, and impression delivery against expectations.",
     "sandbox_actions": [
       {"tool": "get_media_buy_delivery", "guidance": "Pull delivery data for an active sandbox campaign. Evaluate whether the campaign is pacing correctly and identify any anomalies."}
     ],
     "success_criteria": [
       "Successfully retrieves delivery data from a sandbox campaign",
       "Can interpret pacing, spend, and impression metrics",
       "Identifies at least one optimization opportunity from the data"
     ]
   },
   {
     "id": "b3_ex2",
     "title": "Signal discovery and activation",
     "description": "Discover available measurement signals from a sandbox sales agent, then activate appropriate signals for a brand awareness campaign objective.",
     "sandbox_actions": [
       {"tool": "get_signals", "guidance": "Query available signals from a sandbox agent. Identify which signals are relevant for brand awareness vs. direct response."},
       {"tool": "activate_signal", "guidance": "Activate the signals most appropriate for a brand awareness campaign. Explain your choices."}
     ],
     "success_criteria": [
       "Successfully discovers available signals",
       "Selects signals appropriate to the campaign objective",
       "Articulates why each signal matters for brand awareness measurement"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands measurement architecture", "scoring_guide": {"high": "Can explain how delivery reporting, signals, and optimization form a closed loop", "medium": "Understands individual components but not the feedback loop", "low": "Confuses delivery data with signal data"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Can design measurement integration", "scoring_guide": {"high": "Configures appropriate signals for campaign objectives and interprets delivery data", "medium": "Can retrieve delivery data but struggles with signal activation", "low": "Cannot navigate measurement tools"}},
     {"name": "problem_solving", "weight": 25, "description": "Can troubleshoot data discrepancies", "scoring_guide": {"high": "Identifies root causes of delivery discrepancies and proposes corrective actions", "medium": "Notices discrepancies but cannot diagnose the cause", "low": "Cannot identify or reason about data discrepancies"}},
     {"name": "protocol_fluency", "weight": 20, "description": "Correct signals terminology", "scoring_guide": {"high": "Correctly uses get_signals, activate_signal, and delivery metric terms", "medium": "Mostly correct with minor terminology gaps", "low": "Confuses signals with delivery metrics"}}
   ],
   "passing_threshold": 70
 }')
ON CONFLICT (id) DO UPDATE SET
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
-- MODULES — Track C: Buyer / Brand path
-- =====================================================

INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES

('C1', 'C', 'The buyer workflow and multi-agent orchestration',
 'How buyer agents orchestrate across multiple sales agents simultaneously: discovery, portfolio allocation, and measuring reach across publishers.',
 'interactive', 15, 1, false, '{A3}',
 '{
   "objectives": [
     "Understand how a buyer agent discovers and evaluates multiple sellers",
     "Know the multi-agent orchestration pattern: query → compare → allocate → buy → measure",
     "Understand portfolio allocation vs single-vendor buying"
   ],
   "key_concepts": [
     {"topic": "Multi-agent buying", "explanation": "A buyer agent queries multiple sales agents in parallel, compares products, pricing, and targeting options, then allocates budget across the best options. This replaces manual media planning with autonomous portfolio optimization."},
     {"topic": "Orchestration pattern", "explanation": "The buyer agent follows: 1) Discover (get_products from multiple sellers), 2) Evaluate (compare offerings against campaign goals), 3) Allocate (distribute budget optimally), 4) Execute (create_media_buy with each selected seller), 5) Monitor (track delivery and optimize)."},
     {"topic": "Cross-publisher measurement", "explanation": "With buys across multiple publishers, the buyer agent needs to measure aggregate reach, frequency, and performance. Signals from different sellers are combined into a unified view."}
   ],
   "discussion_prompts": [
     "How does a buyer agent decide which sellers to work with?",
     "What are the advantages of agentic portfolio allocation over manual media planning?",
     "How do you measure reach across multiple publishers in an agentic workflow?"
   ],
   "demo_scenarios": [
     {"description": "Query multiple sandbox agents and compare their offerings", "tools": ["get_products"], "expected_outcome": "See how different agents expose different inventory"}
   ]
 }',
 '[
   {
     "id": "c1_ex1",
     "title": "Multi-seller discovery and comparison",
     "description": "Query multiple sandbox sales agents using get_products, compare their product catalogs, and recommend which sellers best fit a given campaign brief.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Query at least two sandbox sales agents. Compare products, pricing, targeting, and format availability across sellers."}
     ],
     "success_criteria": [
       "Successfully queries multiple sales agents in parallel",
       "Identifies meaningful differences in offerings across sellers",
       "Recommends a portfolio allocation with clear rationale"
     ]
   },
   {
     "id": "c1_ex2",
     "title": "Execute a multi-publisher buy",
     "description": "Based on your discovery, create media buys with two different sandbox sales agents to demonstrate cross-publisher campaign execution.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Select the best products from each seller for your campaign goals."},
       {"tool": "create_media_buy", "guidance": "Create a media buy with each selected seller. Allocate budget based on your evaluation."}
     ],
     "success_criteria": [
       "Creates valid media buys with multiple sellers",
       "Budget allocation reflects a reasoned portfolio strategy",
       "Can explain why each seller was chosen"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands multi-agent orchestration", "scoring_guide": {"high": "Can explain the full orchestration pattern: discover, evaluate, allocate, execute, monitor", "medium": "Understands individual steps but not how they connect", "low": "Cannot describe the multi-agent buying workflow"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Can design a buying workflow", "scoring_guide": {"high": "Designs a workflow with parallel discovery, comparison criteria, and allocation logic", "medium": "Creates a basic sequential workflow", "low": "Cannot structure a buying workflow"}},
     {"name": "problem_solving", "weight": 25, "description": "Can handle allocation challenges", "scoring_guide": {"high": "Reasons about portfolio optimization, budget distribution, and tradeoffs", "medium": "Can allocate budget but without optimization rationale", "low": "Cannot reason about allocation across multiple sellers"}},
     {"name": "protocol_fluency", "weight": 20, "description": "Correct buyer workflow terminology", "scoring_guide": {"high": "Correctly uses orchestration, allocation, and cross-publisher terms", "medium": "Mostly correct with minor imprecision", "low": "Confuses buyer and seller terminology"}}
   ],
   "passing_threshold": 70
 }'),

('C2', 'C', 'Brand identity and compliance protocols',
 'The Brand Protocol (well-known/brand.json), Brand Standards Protocol (MCP-based compliance), and how brand agents enforce guidelines across automated buying.',
 'interactive', 12, 2, false, '{C1}',
 '{
   "objectives": [
     "Understand brand.json and how it establishes brand identity in AdCP",
     "Know the Brand Standards Protocol for automated compliance",
     "Understand suitability, safety, and sustainability preferences"
   ],
   "key_concepts": [
     {"topic": "Brand identity protocol", "explanation": "brand.json (at /.well-known/adcp/brand.json) declares a brand''s identity: name, logos, colors, guidelines. Brand agents use this to ensure all advertising is on-brand, even when created by AI."},
     {"topic": "Brand Standards Protocol", "explanation": "MCP-based compliance checking. Brand agents can evaluate proposed creatives, placements, and contexts against brand guidelines before approving a buy. This automated brand safety replaces manual review."},
     {"topic": "Supply chain preferences", "explanation": "Brands specify suitability (what contexts are appropriate), safety (what must be avoided), and sustainability (environmental/social preferences). These propagate through the buying chain."}
   ],
   "discussion_prompts": [
     "Why is brand.json important for automated advertising?",
     "How does automated brand safety compare to manual review processes?",
     "What happens when a brand agent and a sales agent disagree on suitability?"
   ]
 }',
 '[
   {
     "id": "c2_ex1",
     "title": "Brand identity review",
     "description": "Examine a sample brand.json document and evaluate it for completeness. Identify what a brand agent would need to enforce guidelines across automated buying.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Query a sandbox sales agent to understand the inventory context where brand guidelines would be applied."}
     ],
     "success_criteria": [
       "Can identify the key sections of brand.json and their purpose",
       "Evaluates whether brand guidelines are specific enough for automated enforcement",
       "Identifies gaps where a brand agent might lack sufficient guidance"
     ]
   },
   {
     "id": "c2_ex2",
     "title": "Brand compliance evaluation",
     "description": "Given a campaign scenario, evaluate seller inventory against brand suitability, safety, and sustainability preferences. Decide which products pass brand compliance and which do not.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Query a sandbox sales agent. Evaluate each product against a hypothetical brand''s suitability and safety requirements."}
     ],
     "success_criteria": [
       "Applies brand safety and suitability criteria to real product inventory",
       "Makes clear accept/reject decisions with reasoning",
       "Identifies edge cases where compliance is ambiguous"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 30, "description": "Understands brand protocols", "scoring_guide": {"high": "Can explain brand.json, Brand Standards Protocol, and supply chain preferences in detail", "medium": "Understands brand.json but not how automated compliance works", "low": "Confuses brand identity with brand safety"}},
     {"name": "practical_knowledge", "weight": 25, "description": "Can configure brand compliance", "scoring_guide": {"high": "Designs a complete brand compliance setup with suitability, safety, and sustainability rules", "medium": "Can configure basic brand safety rules", "low": "Cannot configure brand compliance settings"}},
     {"name": "problem_solving", "weight": 20, "description": "Can resolve compliance conflicts", "scoring_guide": {"high": "Proposes resolution strategies when brand rules conflict with publisher inventory", "medium": "Identifies conflicts but struggles with resolution", "low": "Cannot identify or resolve compliance conflicts"}},
     {"name": "protocol_fluency", "weight": 25, "description": "Correct brand terminology", "scoring_guide": {"high": "Correctly uses brand.json, suitability, safety, sustainability, and Brand Standards Protocol terms", "medium": "Mostly correct with minor terminology gaps", "low": "Confuses brand protocol concepts with general marketing terms"}}
   ],
   "passing_threshold": 70
 }'),

('C3', 'C', 'Creative workflows and sponsored intelligence',
 'How creative assets flow through AdCP: build_creative, preview_creative, sync_creatives. Formal adaptation across platforms. The Sponsored Intelligence Protocol for conversational AI placements.',
 'interactive', 15, 3, false, '{C2}',
 '{
   "objectives": [
     "Understand the creative lifecycle in AdCP",
     "Know how creative agents produce and adapt assets across formats",
     "Understand the Sponsored Intelligence (SI) Protocol"
   ],
   "key_concepts": [
     {"topic": "Creative lifecycle", "explanation": "build_creative → preview_creative → sync_creatives. Creative agents produce assets based on brand guidelines and format specifications. They can adapt a single concept across display, video, audio, and native formats."},
     {"topic": "Cross-platform adaptation", "explanation": "A creative agent takes brand assets and adapts them for each publisher''s format requirements. This replaces manual resizing and reformatting with intelligent, automated adaptation that respects both brand guidelines and publisher specs."},
     {"topic": "Sponsored Intelligence Protocol", "explanation": "SI enables brands to participate in conversational AI experiences. When a user asks an AI assistant about a product category, SI allows relevant brand information to be surfaced naturally, with full transparency and user control."}
   ],
   "discussion_prompts": [
     "How does the creative lifecycle reduce manual production work?",
     "What role does the creative agent play in cross-platform campaigns?",
     "How does Sponsored Intelligence differ from traditional advertising?"
   ],
   "demo_scenarios": [
     {"description": "Walk through a creative sync with a sandbox agent", "tools": ["sync_creatives", "list_creative_formats"], "expected_outcome": "See how creatives are matched to format specs and synced to publishers"}
   ]
 }',
 '[
   {
     "id": "c3_ex1",
     "title": "Creative format discovery and sync",
     "description": "Discover format specifications from a sandbox publisher, then sync a creative that meets those specifications.",
     "sandbox_actions": [
       {"tool": "list_creative_formats", "guidance": "Query format specs from a sandbox agent. Identify dimensions, file type requirements, and render constraints."},
       {"tool": "sync_creatives", "guidance": "Sync a creative to the sandbox publisher. Ensure it matches the format requirements you discovered."}
     ],
     "success_criteria": [
       "Successfully discovers and interprets format specifications",
       "Syncs a creative that passes format validation",
       "Can explain how format specs guide creative production"
     ]
   },
   {
     "id": "c3_ex2",
     "title": "Sponsored Intelligence connection",
     "description": "Explore the Sponsored Intelligence Protocol by connecting to a sandbox SI agent and understanding how brand information surfaces in conversational AI experiences.",
     "sandbox_actions": [
       {"tool": "connect_to_si_agent", "guidance": "Connect to a sandbox SI agent. Examine how brand information is structured for conversational AI placements."}
     ],
     "success_criteria": [
       "Successfully connects to an SI agent",
       "Can explain how SI differs from traditional display or video advertising",
       "Understands the transparency and user control principles of SI"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands creative workflows", "scoring_guide": {"high": "Can explain the full creative lifecycle and how SI differs from traditional advertising", "medium": "Understands build/sync flow but not SI protocol", "low": "Confuses creative production with creative delivery"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Can execute creative operations", "scoring_guide": {"high": "Successfully syncs creatives that meet format specs and brand guidelines", "medium": "Can sync creatives but struggles with format compliance", "low": "Cannot execute creative operations"}},
     {"name": "problem_solving", "weight": 20, "description": "Can troubleshoot creative issues", "scoring_guide": {"high": "Diagnoses format mismatches and brand compliance failures quickly", "medium": "Can identify issues with guidance", "low": "Cannot diagnose why a creative was rejected"}},
     {"name": "protocol_fluency", "weight": 25, "description": "Correct creative terminology", "scoring_guide": {"high": "Correctly uses sync_creatives, list_creative_formats, renders, and SI terms", "medium": "Mostly correct with occasional imprecision", "low": "Confuses creative lifecycle stages or misnames tools"}}
   ],
   "passing_threshold": 70
 }')
ON CONFLICT (id) DO UPDATE SET
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
-- MODULES — Track D: Platform / Intermediary path
-- =====================================================

INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES

('D1', 'D', 'Implementing AdCP: MCP server architecture',
 'Technical deep dive on building an AdCP-compliant MCP server. Transport options (SSE, Streamable HTTP), tool definition patterns, OAuth/authorization flows.',
 'interactive', 15, 1, false, '{A3}',
 '{
   "objectives": [
     "Understand MCP server architecture for AdCP implementations",
     "Know the transport options and when to use each",
     "Understand OAuth and authorization patterns for agent trust"
   ],
   "key_concepts": [
     {"topic": "MCP server fundamentals", "explanation": "An AdCP-compliant MCP server exposes tools (get_products, create_media_buy, etc.) via the MCP protocol. It handles authentication, authorization, and request routing. The server can be standalone or embedded in existing ad tech infrastructure."},
     {"topic": "Transport options", "explanation": "Streamable HTTP is the primary transport for AdCP. SSE (Server-Sent Events) is supported for real-time updates. The choice depends on your infrastructure: Streamable HTTP for most cases, SSE for long-running operations."},
     {"topic": "Authorization and trust", "explanation": "AdCP uses OAuth 2.0 for agent authentication. Agents present tokens to prove identity. Servers validate tokens, check permissions, and enforce access control. This enables trust between agents from different organizations."}
   ],
   "discussion_prompts": [
     "What are the key differences between building an MCP server and a traditional REST API?",
     "When would you choose SSE over Streamable HTTP?",
     "How does OAuth enable trust between agents from different companies?"
   ]
 }',
 '[
   {
     "id": "d1_ex1",
     "title": "MCP server capability inspection",
     "description": "Use get_adcp_capabilities to inspect a sandbox MCP server. Analyze its tool definitions, transport configuration, and supported protocol version.",
     "sandbox_actions": [
       {"tool": "get_adcp_capabilities", "guidance": "Query the capabilities endpoint of a sandbox MCP server. Examine the tool list, supported transports, and protocol version."}
     ],
     "success_criteria": [
       "Successfully retrieves server capabilities",
       "Can identify registered tools and their schemas",
       "Understands the transport and auth configuration exposed"
     ]
   },
   {
     "id": "d1_ex2",
     "title": "End-to-end MCP server test",
     "description": "Test a sandbox MCP server by calling get_products through it. Verify correct request routing, response structure, and error handling.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Call get_products through the sandbox MCP server. Verify the response follows the AdCP schema. Test with invalid parameters to observe error handling."}
     ],
     "success_criteria": [
       "Successfully calls a tool through the MCP server",
       "Validates that the response conforms to the AdCP schema",
       "Can describe how the server routes and processes the request"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 20, "description": "Understands MCP server architecture", "scoring_guide": {"high": "Can explain MCP server components, tool registration, and request lifecycle", "medium": "Understands basic server concepts but misses tool registration details", "low": "Confuses MCP server with traditional REST API server"}},
     {"name": "practical_knowledge", "weight": 35, "description": "Can design and implement an MCP server", "scoring_guide": {"high": "Designs a server with correct tool definitions, transport, and auth flow", "medium": "Can set up a basic server but struggles with auth configuration", "low": "Cannot structure an MCP server implementation"}},
     {"name": "problem_solving", "weight": 25, "description": "Can debug transport and auth issues", "scoring_guide": {"high": "Diagnoses transport failures, OAuth token issues, and connection problems", "medium": "Can identify some issues with guidance", "low": "Cannot troubleshoot server connectivity or auth failures"}},
     {"name": "protocol_fluency", "weight": 20, "description": "Correct MCP/transport terminology", "scoring_guide": {"high": "Correctly uses Streamable HTTP, SSE, OAuth, tool definitions, and MCP terms", "medium": "Mostly correct with minor imprecision", "low": "Confuses transport mechanisms or misnames protocol concepts"}}
   ],
   "passing_threshold": 70
 }'),

('D2', 'D', 'Supply path and agent trust',
 'Cryptographic signatures for supply chain verification. How platforms validate agent identity, detect fraud, and ensure trust. The relationship between AdCP and ads.cert.',
 'interactive', 12, 2, false, '{D1}',
 '{
   "objectives": [
     "Understand supply chain verification in AdCP",
     "Know how platforms validate agent identity",
     "Understand the trust hierarchy and fraud prevention"
   ],
   "key_concepts": [
     {"topic": "Agent identity verification", "explanation": "Every agent has a verifiable identity through adagents.json. Platforms validate that agents are who they claim to be by checking domain ownership, cryptographic signatures, and organizational registration."},
     {"topic": "Supply path transparency", "explanation": "AdCP provides full visibility into the supply path: which agents handled a transaction, what decisions were made, and why. This replaces opaque supply chains with auditable agent-to-agent interactions."},
     {"topic": "Relationship to ads.cert", "explanation": "ads.cert provides cryptographic verification for RTB bid requests. AdCP extends this concept to agent-to-agent interactions, ensuring that every step in an agentic transaction can be verified."}
   ],
   "discussion_prompts": [
     "How does agent identity verification prevent fraud in agentic advertising?",
     "What are the advantages of supply path transparency in AdCP vs traditional programmatic?",
     "How would you verify that a sales agent actually represents the publisher it claims to?"
   ]
 }',
 '[
   {
     "id": "d2_ex1",
     "title": "Agent identity validation",
     "description": "Validate a sandbox agent''s identity by inspecting its adagents.json. Check domain ownership, declared capabilities, and organizational registration.",
     "sandbox_actions": [
       {"tool": "validate_adagents", "guidance": "Validate the adagents.json of a sandbox agent. Check for domain verification, declared tools, and organizational identity."}
     ],
     "success_criteria": [
       "Successfully retrieves and parses the agent''s adagents.json",
       "Verifies domain ownership and organizational identity claims",
       "Identifies any gaps or weaknesses in the trust declaration"
     ]
   },
   {
     "id": "d2_ex2",
     "title": "Supply path audit",
     "description": "Trace the supply path for a sandbox transaction. Identify each agent in the chain, verify their identities, and assess the transparency of the path.",
     "sandbox_actions": [
       {"tool": "validate_adagents", "guidance": "Validate each agent in the supply path. Verify that every hop is transparent and properly authenticated."},
       {"tool": "get_adcp_capabilities", "guidance": "Check the capabilities of intermediary agents to verify they are authorized to participate in the supply chain."}
     ],
     "success_criteria": [
       "Traces the complete supply path from buyer to seller",
       "Validates each agent''s identity in the chain",
       "Identifies potential risks such as unverified intermediaries"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands trust architecture", "scoring_guide": {"high": "Can explain adagents.json verification, supply path transparency, and ads.cert relationship", "medium": "Understands agent identity but not full supply chain verification", "low": "Cannot describe how agent trust is established"}},
     {"name": "practical_knowledge", "weight": 25, "description": "Can implement trust verification", "scoring_guide": {"high": "Validates agent identity through adagents.json and traces the full supply path", "medium": "Can check basic agent identity but not trace the supply chain", "low": "Cannot perform agent verification"}},
     {"name": "problem_solving", "weight": 30, "description": "Can identify trust chain weaknesses", "scoring_guide": {"high": "Identifies spoofing risks, missing signatures, and trust chain gaps", "medium": "Recognizes obvious trust issues", "low": "Cannot reason about supply chain vulnerabilities"}},
     {"name": "protocol_fluency", "weight": 20, "description": "Correct security terminology", "scoring_guide": {"high": "Correctly uses adagents.json, supply path, cryptographic signature, and ads.cert terms", "medium": "Mostly correct with minor terminology gaps", "low": "Confuses security concepts or misnames verification mechanisms"}}
   ],
   "passing_threshold": 70
 }'),

('D3', 'D', 'RTB migration patterns',
 'How AdCP coexists with existing programmatic infrastructure. Migration strategies for DSPs, SSPs, and exchanges. Running parallel systems during transition.',
 'interactive', 12, 3, false, '{D2}',
 '{
   "objectives": [
     "Understand how AdCP integrates with existing RTB infrastructure",
     "Know migration strategies for different platform types",
     "Understand parallel running and gradual transition"
   ],
   "key_concepts": [
     {"topic": "Coexistence strategy", "explanation": "AdCP doesn''t require replacing existing RTB infrastructure overnight. Platforms can run AdCP alongside OpenRTB, gradually migrating workflows. An AdCP agent can generate RTB bid requests when needed, bridging the two paradigms."},
     {"topic": "Platform-specific migration", "explanation": "DSPs: Start by wrapping existing bidding logic in a buyer agent. SSPs: Expose existing inventory through a sales agent. Exchanges: Build intermediary agents that translate between protocols. Each type has different entry points."},
     {"topic": "Performance benchmarking", "explanation": "During parallel running, measure: campaign performance (agentic vs traditional), operational efficiency (time saved), cost (infrastructure overhead), and quality (brand safety, viewability). Use data to justify deeper migration."}
   ],
   "discussion_prompts": [
     "How would a DSP start adopting AdCP without disrupting existing campaigns?",
     "What metrics would you use to evaluate whether agentic buying outperforms traditional?",
     "What are the biggest risks during a parallel-run migration?"
   ]
 }',
 '[
   {
     "id": "d3_ex1",
     "title": "AdCP capability assessment",
     "description": "Use get_adcp_capabilities to assess a sandbox MCP server''s readiness for production migration. Evaluate protocol version support, tool coverage, and transport options.",
     "sandbox_actions": [
       {"tool": "get_adcp_capabilities", "guidance": "Inspect the sandbox server''s capabilities. Assess whether it supports the tools and transports needed for a production migration from RTB."}
     ],
     "success_criteria": [
       "Successfully assesses the server''s protocol readiness",
       "Identifies which AdCP tools are available vs. which would need to be added",
       "Evaluates transport options for compatibility with existing infrastructure"
     ]
   },
   {
     "id": "d3_ex2",
     "title": "Parallel-run validation",
     "description": "Simulate a parallel-run scenario by querying a sandbox agent via get_products and comparing the response to what an RTB integration would provide. Identify data mapping gaps.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Query the sandbox agent. Map the AdCP product response fields to equivalent OpenRTB concepts (site/app objects, imp objects, floor prices). Identify what translates cleanly and what requires adaptation."}
     ],
     "success_criteria": [
       "Successfully maps AdCP product fields to RTB equivalents",
       "Identifies fields that have no direct RTB mapping",
       "Proposes a strategy for handling data gaps during parallel running"
     ]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 25, "description": "Understands migration patterns", "scoring_guide": {"high": "Can explain coexistence strategies for DSPs, SSPs, and exchanges in detail", "medium": "Understands basic parallel-run concepts but not platform-specific approaches", "low": "Cannot describe how AdCP integrates with existing RTB infrastructure"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Can design a migration plan", "scoring_guide": {"high": "Designs a phased migration plan with benchmarks, rollback criteria, and success metrics", "medium": "Creates a basic migration plan but lacks benchmarking criteria", "low": "Cannot structure a migration plan"}},
     {"name": "problem_solving", "weight": 25, "description": "Can handle transition challenges", "scoring_guide": {"high": "Anticipates data consistency, performance, and operational challenges during migration", "medium": "Identifies some transition risks", "low": "Cannot reason about migration risks or failure scenarios"}},
     {"name": "protocol_fluency", "weight": 20, "description": "Correct RTB/AdCP terminology", "scoring_guide": {"high": "Correctly uses RTB, OpenRTB, DSP, SSP, and AdCP coexistence terms", "medium": "Mostly correct with minor imprecision", "low": "Confuses RTB and AdCP concepts or misnames platform types"}}
   ],
   "passing_threshold": 70
 }')
ON CONFLICT (id) DO UPDATE SET
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
-- MODULES — Track E: Protocol-specific capstone modules
-- Each combines a hands-on lab + adaptive exam (~30 min)
-- =====================================================

INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES

('E1', 'E', 'Capstone: Media buy',
 'Protocol-specific capstone combining hands-on lab and adaptive exam. Covers the full media buy transaction lifecycle: product discovery, campaign creation, budget management, and delivery reporting.',
 'capstone', 30, 1, false, '{A3}',
 '{
   "objectives": [
     "Execute a complete media buy lifecycle against sandbox agents",
     "Demonstrate fluency with get_products, create_media_buy, update_media_buy, and get_media_buy_delivery",
     "Handle multi-agent orchestration: compare sellers, allocate budget, manage concurrent buys",
     "Troubleshoot common transaction failures and recovery patterns"
   ],
   "key_concepts": [
     {"topic": "Transaction lifecycle", "explanation": "The full media buy flow: discover products → evaluate pricing and targeting → create a media buy → monitor delivery → adjust with update_media_buy. Each step has its own protocol patterns and potential failure modes."},
     {"topic": "Multi-agent orchestration", "explanation": "A buyer agent queries multiple sales agents in parallel, comparing products and pricing. Portfolio allocation distributes budget optimally across sellers. This replaces manual media planning with autonomous optimization."},
     {"topic": "Pricing and negotiation", "explanation": "Products have pricing models (CPM, flat rate, hybrid), minimum spend requirements, and availability windows. The buyer agent evaluates these against campaign goals. update_media_buy enables mid-flight adjustments."},
     {"topic": "Delivery and reconciliation", "explanation": "get_media_buy_delivery tracks impressions, spend, and pacing. Discrepancies between expected and actual delivery require diagnosis — was it targeting too narrow, budget too low, or creative rejection?"}
   ],
   "discussion_prompts": [
     "Walk through how you would set up a multi-publisher campaign from scratch.",
     "A media buy is under-delivering — walk through your diagnostic process.",
     "How does agentic portfolio allocation differ from traditional media planning?"
   ],
   "demo_scenarios": [
     {"description": "Discover products and compare seller offerings", "tools": ["get_products"], "expected_outcome": "Evaluate and compare at least two sellers"},
     {"description": "Execute a complete media buy", "tools": ["get_products", "create_media_buy"], "expected_outcome": "Successfully create a media buy with appropriate parameters"},
     {"description": "Monitor and adjust a campaign", "tools": ["get_media_buy_delivery", "update_media_buy"], "expected_outcome": "Check delivery data and make an informed adjustment"}
   ]
 }',
 '[
   {
     "id": "e1_ex1",
     "title": "Multi-seller discovery and evaluation",
     "description": "Query multiple sandbox sales agents, compare their product catalogs, pricing, and targeting options. Recommend a budget allocation.",
     "sandbox_actions": [
       {"tool": "get_products", "guidance": "Query at least two sandbox agents. Compare products, formats, pricing models, and targeting options."}
     ],
     "success_criteria": ["Queries multiple agents successfully", "Identifies meaningful differences between catalogs", "Recommends a rational allocation"]
   },
   {
     "id": "e1_ex2",
     "title": "Execute and manage a media buy",
     "description": "Create a media buy with a sandbox sales agent, then check delivery and make an adjustment.",
     "sandbox_actions": [
       {"tool": "create_media_buy", "guidance": "Create a media buy using the best product from your discovery."},
       {"tool": "get_media_buy_delivery", "guidance": "Check delivery status after creation."},
       {"tool": "update_media_buy", "guidance": "Make an informed adjustment based on the delivery data."}
     ],
     "success_criteria": ["Creates a valid media buy", "Retrieves delivery data", "Makes a reasonable adjustment with clear rationale"]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 15, "description": "Understands transaction lifecycle and pricing", "scoring_guide": {"high": "Explains flow with nuance", "medium": "Gets main steps right", "low": "Misses key transaction concepts"}},
     {"name": "practical_knowledge", "weight": 35, "description": "Successfully executes media buy operations", "scoring_guide": {"high": "Completes all tasks efficiently", "medium": "Completes tasks with some guidance", "low": "Struggles with tool usage"}},
     {"name": "problem_solving", "weight": 25, "description": "Diagnoses delivery and transaction issues", "scoring_guide": {"high": "Identifies root causes quickly", "medium": "Can diagnose with hints", "low": "Cannot reason about failures"}},
     {"name": "communication_clarity", "weight": 10, "description": "Explains decisions and rationale clearly", "scoring_guide": {"high": "Clear, structured reasoning", "medium": "Mostly clear", "low": "Confusing explanations"}},
     {"name": "protocol_fluency", "weight": 15, "description": "Correct use of media buy tools and terminology", "scoring_guide": {"high": "Precise tool usage and terminology", "medium": "Mostly correct", "low": "Frequently misuses terms"}}
   ],
   "passing_threshold": 70
 }'),

('E2', 'E', 'Capstone: Creative',
 'Protocol-specific capstone combining hands-on lab and adaptive exam. Covers creative workflows: format discovery, asset production, cross-platform adaptation, and creative sync.',
 'capstone', 30, 2, false, '{A3}',
 '{
   "objectives": [
     "Navigate the full creative lifecycle: discover formats, build creatives, preview, and sync to publishers",
     "Demonstrate fluency with list_creative_formats, sync_creatives, build_creative, and preview_creative",
     "Handle cross-platform creative adaptation — same concept, multiple format specifications",
     "Troubleshoot creative rejection and format compliance issues"
   ],
   "key_concepts": [
     {"topic": "Creative lifecycle", "explanation": "list_creative_formats (discover specs) → build_creative (produce assets) → preview_creative (validate) → sync_creatives (deliver to publisher). The creative agent adapts assets intelligently based on brand guidelines and publisher specifications."},
     {"topic": "Format compliance", "explanation": "Each publisher specifies exact format requirements: dimensions, file types, max file sizes, required fields. Creative agents must produce compliant assets. Non-compliant creatives are rejected, blocking campaign delivery."},
     {"topic": "Cross-platform adaptation", "explanation": "A single creative concept must render correctly across display (300x250, 728x90), video (pre-roll, CTV), native, and audio. Creative agents handle this adaptation automatically while maintaining brand consistency."},
     {"topic": "Brand consistency", "explanation": "Creative agents reference brand.json for logos, colors, voice, and guidelines. All generated assets must be on-brand regardless of the format or publisher. Brand agents can validate compliance before sync."}
   ],
   "discussion_prompts": [
     "A creative is rejected by a publisher — walk through your debugging process.",
     "How does a creative agent balance brand guidelines with publisher format requirements?",
     "What is the relationship between list_creative_formats and sync_creatives?"
   ],
   "demo_scenarios": [
     {"description": "Discover creative format specifications from a sandbox agent", "tools": ["list_creative_formats"], "expected_outcome": "Understand format requirements including dimensions, file types, and constraints"},
     {"description": "Build and preview a creative", "tools": ["build_creative", "preview_creative"], "expected_outcome": "Produce a compliant creative and validate it"},
     {"description": "Sync a creative to a publisher", "tools": ["sync_creatives"], "expected_outcome": "Successfully deliver a creative that passes format validation"}
   ]
 }',
 '[
   {
     "id": "e2_ex1",
     "title": "Format discovery and creative production",
     "description": "Query a sandbox agent for creative format specifications, then build a creative matching those specs.",
     "sandbox_actions": [
       {"tool": "list_creative_formats", "guidance": "Query creative format specs from a sandbox agent. Identify key requirements."},
       {"tool": "build_creative", "guidance": "Build a creative matching the format requirements you discovered."},
       {"tool": "preview_creative", "guidance": "Preview the creative to validate it before syncing."}
     ],
     "success_criteria": ["Correctly identifies format requirements", "Builds a compliant creative", "Previews and validates before delivery"]
   },
   {
     "id": "e2_ex2",
     "title": "Cross-platform sync and troubleshooting",
     "description": "Sync creatives to a sandbox publisher and handle any compliance issues.",
     "sandbox_actions": [
       {"tool": "sync_creatives", "guidance": "Sync your creative to the publisher. If rejected, diagnose the issue and fix it."}
     ],
     "success_criteria": ["Successfully syncs a creative", "Can diagnose and resolve format compliance issues"]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 15, "description": "Understands creative lifecycle and format compliance", "scoring_guide": {"high": "Explains creative flow with nuance", "medium": "Gets main steps right", "low": "Confused about creative workflow"}},
     {"name": "practical_knowledge", "weight": 35, "description": "Successfully executes creative operations", "scoring_guide": {"high": "Produces compliant creatives efficiently", "medium": "Completes tasks with guidance", "low": "Struggles with creative tools"}},
     {"name": "problem_solving", "weight": 25, "description": "Diagnoses creative rejection and compliance issues", "scoring_guide": {"high": "Quickly identifies format mismatches", "medium": "Can diagnose with hints", "low": "Cannot troubleshoot rejections"}},
     {"name": "communication_clarity", "weight": 10, "description": "Explains creative decisions clearly", "scoring_guide": {"high": "Clear reasoning about creative choices", "medium": "Mostly clear", "low": "Confusing explanations"}},
     {"name": "protocol_fluency", "weight": 15, "description": "Correct use of creative tools and terminology", "scoring_guide": {"high": "Precise tool usage", "medium": "Mostly correct", "low": "Misuses creative terminology"}}
   ],
   "passing_threshold": 70
 }'),

('E3', 'E', 'Capstone: Signals',
 'Protocol-specific capstone combining hands-on lab and adaptive exam. Covers the measurement framework: signal discovery, activation, attribution, and optimization feedback loops.',
 'capstone', 30, 3, false, '{A3}',
 '{
   "objectives": [
     "Navigate the signals framework: discover available signals, activate measurement, analyze results",
     "Demonstrate fluency with get_signals and activate_signal",
     "Design optimization feedback loops using signal data",
     "Understand attribution models and measurement integration patterns"
   ],
   "key_concepts": [
     {"topic": "Signals framework", "explanation": "Signals are measurement data points: viewability, brand lift, conversions, audience reach, attention. get_signals returns available signals for a publisher. activate_signal enables specific measurement on a campaign."},
     {"topic": "Measurement activation", "explanation": "Not all signals are active by default. Buyer agents selectively activate signals based on campaign objectives. Premium signals (brand lift, attention) may have additional costs. The activation model replaces fragmented measurement vendor integrations."},
     {"topic": "Attribution and optimization", "explanation": "Signal data feeds back into campaign optimization. Buyer agents use viewability, completion rates, and conversion signals to adjust targeting, budgets, and creative rotation. The optimization loop is continuous and automated."},
     {"topic": "Cross-publisher measurement", "explanation": "With buys across multiple publishers, signals must be aggregated into a unified view. Frequency management, reach deduplication, and cross-platform attribution all depend on consistent signal data."}
   ],
   "discussion_prompts": [
     "How do signals replace traditional measurement vendor integrations?",
     "Design an optimization loop using signal data for a brand awareness campaign.",
     "What challenges arise when aggregating signals across multiple publishers?"
   ],
   "demo_scenarios": [
     {"description": "Discover available signals from a sandbox agent", "tools": ["get_signals"], "expected_outcome": "Identify available signal types and their costs"},
     {"description": "Activate measurement signals on a campaign", "tools": ["activate_signal"], "expected_outcome": "Successfully activate relevant signals with clear rationale"}
   ]
 }',
 '[
   {
     "id": "e3_ex1",
     "title": "Signal discovery and activation",
     "description": "Query available signals from a sandbox agent, evaluate which to activate for a given campaign objective, and activate them.",
     "sandbox_actions": [
       {"tool": "get_signals", "guidance": "Query available signals. Identify which are relevant for a brand awareness campaign vs. a performance campaign."},
       {"tool": "activate_signal", "guidance": "Activate the signals you believe are most relevant. Explain your reasoning."}
     ],
     "success_criteria": ["Successfully queries signals", "Makes informed activation decisions", "Can articulate why specific signals matter for different objectives"]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 20, "description": "Understands measurement architecture and attribution", "scoring_guide": {"high": "Explains signal framework with nuance", "medium": "Gets main concepts right", "low": "Confused about measurement"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Successfully executes signal operations", "scoring_guide": {"high": "Activates appropriate signals with clear rationale", "medium": "Completes tasks with guidance", "low": "Struggles with signal tools"}},
     {"name": "problem_solving", "weight": 25, "description": "Designs optimization loops and diagnoses measurement issues", "scoring_guide": {"high": "Creates sophisticated feedback loops", "medium": "Basic optimization reasoning", "low": "Cannot connect signals to optimization"}},
     {"name": "communication_clarity", "weight": 10, "description": "Explains measurement decisions clearly", "scoring_guide": {"high": "Clear, data-driven reasoning", "medium": "Mostly clear", "low": "Confusing explanations"}},
     {"name": "protocol_fluency", "weight": 15, "description": "Correct use of signals terminology", "scoring_guide": {"high": "Precise use of signal terms", "medium": "Mostly correct", "low": "Misuses measurement terminology"}}
   ],
   "passing_threshold": 70
 }'),

('E4', 'E', 'Capstone: Governance',
 'Protocol-specific capstone combining hands-on lab and adaptive exam. Covers governance protocols: property lists, content standards, brand safety calibration, and compliance automation.',
 'capstone', 30, 4, false, '{A3}',
 '{
   "objectives": [
     "Configure governance controls: property lists and content standards",
     "Demonstrate fluency with create_property_list, create_content_standards, and calibrate_content",
     "Design a brand safety framework using AdCP governance tools",
     "Understand compliance automation and supply chain verification"
   ],
   "key_concepts": [
     {"topic": "Property lists", "explanation": "Property lists define which publisher domains/apps are included or excluded from a campaign. create_property_list creates inclusion or exclusion lists. update_property_list maintains them as new inventory emerges. This automates brand safety at the supply level."},
     {"topic": "Content standards", "explanation": "Content standards define what content is acceptable adjacent to ads. create_content_standards specifies rules (e.g., news categories, sentiment thresholds, keyword exclusions). Buyer agents apply these automatically during evaluation."},
     {"topic": "Content calibration", "explanation": "calibrate_content evaluates specific content against defined standards. This enables real-time compliance checking — before placing an ad, the buyer agent can verify the surrounding content meets brand safety requirements."},
     {"topic": "Compliance automation", "explanation": "Together, property lists + content standards + calibration create an automated compliance framework. Instead of manual inclusion/exclusion list management, agents continuously evaluate and enforce brand safety rules."}
   ],
   "discussion_prompts": [
     "Design a brand safety framework for a conservative financial services brand.",
     "How do content standards interact with property lists?",
     "What happens when a publisher''s content changes after a media buy is placed?"
   ],
   "demo_scenarios": [
     {"description": "Create a property list and content standards", "tools": ["create_property_list", "create_content_standards"], "expected_outcome": "Configure a governance framework for a hypothetical brand"},
     {"description": "Calibrate content against standards", "tools": ["calibrate_content"], "expected_outcome": "Evaluate content and demonstrate compliance checking"}
   ]
 }',
 '[
   {
     "id": "e4_ex1",
     "title": "Governance framework design",
     "description": "Create a property list and content standards for a hypothetical brand, then calibrate sample content against those standards.",
     "sandbox_actions": [
       {"tool": "create_property_list", "guidance": "Create an inclusion or exclusion list for a brand. Explain your choices."},
       {"tool": "create_content_standards", "guidance": "Define content standards appropriate for the brand."},
       {"tool": "calibrate_content", "guidance": "Test sample content against your standards. Evaluate the results."}
     ],
     "success_criteria": ["Creates appropriate property list", "Defines relevant content standards", "Successfully calibrates content", "Can reason about edge cases"]
   }
 ]',
 '{
   "dimensions": [
     {"name": "conceptual_understanding", "weight": 20, "description": "Understands governance architecture and compliance", "scoring_guide": {"high": "Explains governance framework with nuance", "medium": "Gets main concepts right", "low": "Confused about compliance tools"}},
     {"name": "practical_knowledge", "weight": 30, "description": "Successfully configures governance controls", "scoring_guide": {"high": "Creates appropriate, thorough controls", "medium": "Completes tasks with guidance", "low": "Struggles with governance tools"}},
     {"name": "problem_solving", "weight": 25, "description": "Handles edge cases and compliance conflicts", "scoring_guide": {"high": "Anticipates and resolves conflicts", "medium": "Handles basic scenarios", "low": "Cannot reason about compliance edge cases"}},
     {"name": "communication_clarity", "weight": 10, "description": "Explains governance decisions clearly", "scoring_guide": {"high": "Clear policy reasoning", "medium": "Mostly clear", "low": "Confusing explanations"}},
     {"name": "protocol_fluency", "weight": 15, "description": "Correct use of governance terminology", "scoring_guide": {"high": "Precise governance terminology", "medium": "Mostly correct", "low": "Misuses compliance terms"}}
   ],
   "passing_threshold": 70
 }')
ON CONFLICT (id) DO UPDATE SET
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
