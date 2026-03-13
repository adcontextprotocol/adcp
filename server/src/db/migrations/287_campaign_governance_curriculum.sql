-- Migration: Integrate campaign governance across certification curriculum
--
-- Campaign governance provides always-on compliance for autonomous agent
-- transactions. Media plans already exist in the industry — campaign governance
-- ties campaigns to those plans and protects them so a malicious, hallucinating,
-- or otherwise out-of-line agent can't violate what the buyer decided.
--
-- This migration updates teaching guidance across all tiers:
--   A1: Trust narrative (always-on compliance, three-party validation)
--   A3: Campaign governance in the domain survey
--   B3: Seller-side governance checks and planned delivery
--   C2: Campaign plans, governance loop, policy registry
--   D2: Platform implementation of governance flow
--   E4: Expanded governance capstone with campaign governance labs

-- ============================================================
-- TIER 1: BASICS
-- ============================================================

-- A1: Add trust narrative — why agentic advertising is trustworthy
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (lesson_plan->'key_concepts') || '[
    {"topic": "Always-on compliance", "teaching_notes": "Address the natural objection: how do you trust AI agents to spend your money? In traditional advertising, compliance depends on periodic human review — someone checking the work. With autonomous agents, compliance is structural: every transaction is validated against the media plan before it executes. Three independent parties check each action — the buyer''s orchestrator, an independent governance agent, and the seller. No single party grades its own homework. This isn''t a new concept — media plans already exist. Campaign governance just makes sure every campaign ties to that plan, automatically, on every transaction. Reference the campaign governance overview for details."}
  ]'::jsonb
) WHERE id = 'A1';

-- A1: Add learning objective
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{objectives}',
  (lesson_plan->'objectives') || '["Explain how campaign governance provides always-on compliance for autonomous agent transactions"]'::jsonb
) WHERE id = 'A1';

-- A3: Add campaign governance to domain survey concepts
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (lesson_plan->'key_concepts') || '[
    {"topic": "Campaign governance and policy registry", "teaching_notes": "When surveying governance domains, include campaign governance: the protocol that ties campaigns to media plans and ensures every transaction is validated before it executes. The policy registry is a community-maintained library of advertising regulations (COPPA, GDPR, HFSS) and standards (alcohol, pharma) that brands reference by ID instead of writing their own rules. Keep this at survey depth — name it, explain it in one sentence, move on. Reference the campaign governance overview and policy registry docs."}
  ]'::jsonb
) WHERE id = 'A3';

-- ============================================================
-- TIER 2: PRACTITIONER TRACKS
-- ============================================================

-- C2: Campaign plans, governance loop, policy registry (buyer perspective)
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (lesson_plan->'key_concepts') || '[
    {"topic": "Campaign plans and budget authority", "teaching_notes": "Campaign plans define what an orchestrator is authorized to do — budget limits, channels, flight dates, authorized markets. Media plans already exist in the industry. Campaign governance ties your campaigns to those plans and protects them. The plan lives with the governance agent, not the orchestrator. Cover budget authority levels and reallocation thresholds. Use a concrete example: $500K plan, US-only, OLV + CTV, Q2. Reference the campaign governance overview."},
    {"topic": "The buyer governance loop", "teaching_notes": "Before every seller interaction, the orchestrator calls check_governance with binding ''proposed''. If approved, proceed. If denied, stop. If ''conditions'', adjust and re-check. After the seller confirms delivery, call report_plan_outcome to close the loop and commit budget. Budget is committed on confirmed outcomes, not intent — this prevents phantom spend. Reference the check_governance task reference."},
    {"topic": "Policy registry and compliance", "teaching_notes": "The policy registry is a shared library of advertising regulations and standards. Brands select applicable policies by ID — they don''t write their own COPPA rules. Policies include enforcement levels (must/should/may from RFC 2119). The governance agent resolves policies automatically based on brand configuration and campaign markets. This separates who defines policies (policy team) from who executes campaigns (buying team). Reference the policy registry docs."},
    {"topic": "Governance modes as deployment strategy", "teaching_notes": "Three modes form an adoption path: audit (log everything, never block — for learning), advisory (return real statuses but don''t block — for tuning), enforce (block on violations — for production). Nobody starts at enforce. This gives teams time to calibrate their plans and policies before going live."}
  ]'::jsonb
) WHERE id = 'C2';

-- C2: Add discussion prompts
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{discussion_prompts}',
  COALESCE(lesson_plan->'discussion_prompts', '[]'::jsonb) || '[
    "A buyer sets a $500K plan for US-only. The orchestrator tries to buy $200K of Canadian inventory. What happens?",
    "Why is it important that budget is committed on confirmed outcomes rather than when the orchestrator requests the buy?",
    "How does the policy registry reduce the compliance burden for brands operating in multiple jurisdictions?"
  ]'::jsonb
) WHERE id = 'C2';

-- B3: Seller-side governance checks (seller perspective)
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (lesson_plan->'key_concepts') || '[
    {"topic": "Seller-side governance checks", "teaching_notes": "When a buyer account has governance_agents configured (set during sync_accounts), the seller calls check_governance with binding ''committed'' before confirming a media buy. The seller presents its planned_delivery — what it will actually run. The governance agent checks this against the buyer''s plan. If denied, the seller rejects the buy. This prevents the seller from delivering something unauthorized, and prevents the orchestrator from bypassing governance. Three phases: purchase (before confirming), modification (before updating), delivery (periodic during flight). Start with purchase-only and add phases incrementally. Reference the campaign governance overview and check_governance task reference."},
    {"topic": "Planned delivery and competitive advantage", "teaching_notes": "When confirming a media buy, the seller returns a planned_delivery describing what it will actually deliver (geo, channels, budget, frequency caps). This may differ from what the buyer requested. The governance agent validates it against the plan. Ask: when would planned_delivery differ from the request? Is that acceptable? Implementing governance checks is a competitive advantage — reduced disputes, premium positioning, regulatory cover."}
  ]'::jsonb
) WHERE id = 'B3';

-- B3: Add discussion prompts
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{discussion_prompts}',
  COALESCE(lesson_plan->'discussion_prompts', '[]'::jsonb) || '[
    "A buyer requests US-only delivery but your inventory spans US and Canada. What does the governance check catch?",
    "Why does the seller call the buyer''s governance agent rather than running its own governance layer?",
    "How does implementing governance checks give you a competitive advantage as a seller?"
  ]'::jsonb
) WHERE id = 'B3';

-- D2: Platform implementation of governance flow
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (lesson_plan->'key_concepts') || '[
    {"topic": "Campaign governance architecture", "teaching_notes": "Platform builders implement the three-party validation flow. When a buyer calls sync_accounts, it can include governance_agents — URLs with credentials that the seller uses for committed governance checks. The platform needs to: store governance_agent configuration per account, call check_governance with binding ''committed'' before executing media buys on accounts that have governance agents, handle all four statuses (approved, denied, conditions, escalated). Cover governance modes (audit, advisory, enforce) as an adoption path. Reference the campaign governance specification."},
    {"topic": "Policy registry integration", "teaching_notes": "Platforms building governance agents integrate with the policy registry. Policies are resolved by ID, include natural language text for LLM evaluation, and have calibration exemplars. Cover the registry API (resolve, bulk-resolve, list). Governance agents declare which validation categories they evaluate via get_adcp_capabilities. What happens when the governance agent is unreachable? The protocol requires the seller to halt — never proceed without validation. Reference the policy registry docs."}
  ]'::jsonb
) WHERE id = 'D2';

-- D2: Add discussion prompts
UPDATE certification_modules SET lesson_plan = jsonb_set(
  lesson_plan,
  '{discussion_prompts}',
  COALESCE(lesson_plan->'discussion_prompts', '[]'::jsonb) || '[
    "If you''re building a platform that hosts sales agents, how would you implement governance checks? What happens when the governance agent is unreachable?",
    "Why does the protocol require the seller to halt when the governance agent is unavailable rather than proceeding?"
  ]'::jsonb
) WHERE id = 'D2';

-- ============================================================
-- TIER 3: SPECIALIST CAPSTONE (E4/S4)
-- ============================================================

-- E4: Update title and description to reflect expanded scope
UPDATE certification_modules SET
  title = 'Capstone: Governance',
  description = 'Protocol-specific capstone combining hands-on lab and adaptive exam. Covers the full governance protocol: property lists, content standards, creative governance, campaign governance, and the policy registry. Multi-party validation, budget authority, compliance automation, and audit trails.',
  duration_minutes = 45
WHERE id = 'E4';

-- E4: Replace lesson plan with expanded version including campaign governance
UPDATE certification_modules SET lesson_plan = '{
  "objectives": [
    "Configure governance controls: property lists, content standards, and creative policies",
    "Demonstrate fluency with property list and content standards CRUD lifecycle",
    "Create and validate campaign plans with budget authority and policy configuration",
    "Execute the full governance loop: sync_plans, check_governance (proposed + committed), report_plan_outcome",
    "Use the policy registry to resolve and apply compliance policies",
    "Interpret audit logs and reason about drift metrics",
    "Design a compliance framework using AdCP governance tools"
  ],
  "key_concepts": [
    {"topic": "Governance overview", "teaching_notes": "Cover the full governance landscape: property lists, content standards, creative policy, campaign governance, and the policy registry. Governance is broader than brand safety — it includes automated compliance, multi-party validation, and financial controls. Reference the governance protocol docs."},
    {"topic": "Property lists", "teaching_notes": "Property lists define included/excluded publisher domains and apps. create_property_list and update_property_list manage these. Have the learner create lists for different brand risk profiles."},
    {"topic": "Content standards and calibration", "teaching_notes": "Content standards define acceptable adjacent content. calibrate_content evaluates content against those standards in real time. Have the learner create standards and test content against them using sandbox tools."},
    {"topic": "Campaign governance protocol", "teaching_notes": "Four tasks: sync_plans, check_governance, report_plan_outcome, get_plan_audit_logs. The campaign plan defines authorized parameters — budget, channels, flight dates, markets. check_governance has two binding levels: proposed (orchestrator, advisory) and committed (seller, binding). Budget is committed on confirmed outcomes, not intent. Cover the full loop with the lab exercise. Reference the campaign governance overview and task reference docs."},
    {"topic": "Multi-party trust model", "teaching_notes": "Three-party validation: orchestrator checks proposed actions, seller independently checks committed delivery, governance agent validates both against the same plan. No party grades its own homework. Cover separation of duties: policy team configures, buying team executes, governance agent validates. Cover governance modes (audit → advisory → enforce) as a deployment path."},
    {"topic": "Policy registry", "teaching_notes": "Community-maintained library of 14+ seeded policies covering regulations (COPPA, GDPR, HFSS, EU AI Act) and standards (alcohol, pharma, gambling). Policies include enforcement levels (must/should/may), jurisdiction scope, and calibration exemplars. Governance agents resolve policies by ID and use natural language text plus exemplars in evaluation. Cover three tiers: always-on (automatic by jurisdiction), best practices (opt-in by vertical), brand-specific (custom). Reference the policy registry docs."},
    {"topic": "Budget protection and audit trails", "teaching_notes": "Budget committed on confirmed outcomes via report_plan_outcome, not on check_governance approval. This prevents phantom spend. Audit logs surface aggregate metrics: escalation rate, auto-approval rate, human override rate with trend indicators. A declining escalation rate may mean good calibration or eroding oversight — the metric surfaces the question. Reference the specification docs."},
    {"topic": "Compliance automation", "teaching_notes": "Property lists + content standards + creative policy + campaign governance + policy registry compose into an automated compliance framework. Discuss how these layers interact — a media buy might pass campaign governance (correct budget, market) but fail content standards (inappropriate adjacent content). Each layer catches different violations."}
  ],
  "discussion_prompts": [
    "Design a compliance framework for a conservative financial services brand operating in the US, UK, and EU.",
    "How do content standards interact with campaign governance? Give an example where a buy passes one but fails the other.",
    "What happens when a publisher''s content changes after a media buy is placed?",
    "A governance agent reports a declining escalation rate over 3 months. Is that good or bad? What questions would you ask?",
    "Why does budget commit on confirmed outcomes instead of on governance approval?"
  ],
  "demo_scenarios": [
    {"description": "Create a property list and content standards", "tools": ["create_property_list", "create_content_standards"], "expected_outcome": "Configure a governance framework for a hypothetical brand"},
    {"description": "Calibrate content against standards", "tools": ["calibrate_content"], "expected_outcome": "Evaluate content and demonstrate compliance checking"},
    {"description": "Campaign governance lifecycle", "tools": ["sync_plans", "check_governance", "report_plan_outcome", "get_plan_audit_logs"], "expected_outcome": "Create a plan, validate actions, report outcomes, review audit trail"},
    {"description": "Policy resolution and enforcement", "tools": ["sync_plans", "check_governance"], "expected_outcome": "Configure policies from the registry and verify enforcement on media buys"}
  ]
}'::jsonb
WHERE id = 'E4';

-- E4: Replace exercise definitions with expanded set including campaign governance
UPDATE certification_modules SET exercise_definitions = '[
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
  },
  {
    "id": "e4_ex2",
    "title": "Campaign governance lifecycle",
    "description": "Create a campaign plan, validate actions against it, handle denials and conditions, report outcomes, and review audit logs.",
    "sandbox_actions": [
      {"tool": "sync_plans", "guidance": "Create a campaign plan with budget limits, authorized markets, and policy references."},
      {"tool": "check_governance", "guidance": "Call with binding proposed for a valid action (should approve) and an invalid action (should deny or return conditions). Test at least two validation categories."},
      {"tool": "report_plan_outcome", "guidance": "Report the outcome of an approved action. Verify budget commitment."},
      {"tool": "get_plan_audit_logs", "guidance": "Review the audit trail. Identify the governance decisions made and any findings."}
    ],
    "success_criteria": ["Creates a valid campaign plan with budget authority and policy configuration", "Demonstrates the proposed/committed binding difference", "Handles denied and conditions statuses correctly", "Reports outcomes and verifies budget state", "Interprets audit logs including findings and drift metrics"]
  },
  {
    "id": "e4_ex3",
    "title": "Policy resolution and compliance",
    "description": "Use the policy registry to resolve policies, then configure a campaign plan that enforces them. Verify that violations are caught.",
    "sandbox_actions": [
      {"tool": "sync_plans", "guidance": "Create a plan that references registry policies and targets specific jurisdictions."},
      {"tool": "check_governance", "guidance": "Test a media buy that violates one of the referenced policies. Verify the governance agent catches it."}
    ],
    "success_criteria": ["Configures a plan with policy references matched to campaign jurisdictions", "Demonstrates that policy violations are caught during governance checks", "Can explain the difference between regulation (must) and standard (should) enforcement", "Reasons about how jurisdiction scope affects policy application"]
  }
]'::jsonb
WHERE id = 'E4';

-- E4: Replace assessment criteria with updated dimensions
UPDATE certification_modules SET assessment_criteria = '{
  "dimensions": [
    {"name": "protocol_mastery", "weight": 25, "description": "Full governance protocol mastery across all domains", "scoring_guide": {"high": "Completes all lab exercises including campaign governance lifecycle. Demonstrates CRUD for content standards and property lists, plus the full governance loop (sync_plans, check_governance, report_plan_outcome, get_plan_audit_logs).", "medium": "Completes most exercises but needs guidance on campaign governance or policy resolution.", "low": "Cannot complete the governance lifecycle exercises."}},
    {"name": "safety_expertise", "weight": 25, "description": "Understands the trust model, separation of duties, and how governance domains compose", "scoring_guide": {"high": "Explains the three-party trust model, separation of duties, governance modes, and how campaign governance composes with content standards, property governance, and creative governance.", "medium": "Understands the trust model at a high level but cannot reason about composition across domains.", "low": "Cannot explain why multi-party validation matters."}},
    {"name": "oracle_understanding", "weight": 20, "description": "Understands AI-driven evaluation models and policy resolution", "scoring_guide": {"high": "Explains the Oracle model for content evaluation AND policy registry integration for campaign governance. Understands that governance agents are LLMs that interpret natural language policy text with calibration exemplars.", "medium": "Understands content evaluation but not policy registry integration.", "low": "Cannot explain how AI evaluates compliance."}},
    {"name": "compliance_skill", "weight": 30, "description": "Handles regulatory requirements, policy resolution, and audit interpretation", "scoring_guide": {"high": "Resolves policies from the registry, configures jurisdiction-scoped enforcement, interprets audit logs with drift metrics, and reasons about the three tiers of policy application (always-on, best practices, brand-specific).", "medium": "Can work with policies but struggles with jurisdiction scoping or drift interpretation.", "low": "Cannot configure compliance policies."}}
  ],
  "passing_threshold": 70
}'::jsonb
WHERE id = 'E4';
