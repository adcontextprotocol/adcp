-- Decision-Makers track: a standalone, reasoning-only credential for non-technical
-- brand leaders, agency executives, and SMB owners who evaluate, brief, and decide
-- but do not build agents.
--
-- Why this exists: every other track (A/B/C/D/S) gates on hands-on work — A1 requires
-- querying a live agent and the role tracks culminate in building a working agent.
-- The brand-side decision-makers in docs/learning/test-personas.md (James, Daniela,
-- Priya) delegate that work and could not earn any credential. This track closes that
-- gap with three short, free modules assessed entirely through strategic reasoning.
--
-- Design constraints encoded below:
--   * Track L has badge_type = NULL so it is NOT counted as a "specialization track"
--     by the Practitioner credential's requires_any_track_complete check
--     (checkCredentialEligibility joins on certification_tracks.badge_type IS NOT NULL).
--   * Modules have empty sandbox_actions and tenant_ids stays NULL — there are no live
--     agent queries. Assessment is strategic reasoning, gradable by Sage through
--     conversation, per docs/learning/instructional-design.mdx assessment fairness.
--   * Every success criterion carries a stable semantic id ({module}_{exercise}_sc_{concept})
--     so the recertification engine can flag holders individually if a concept changes.
--   * The decision_makers credential is tier 1 (free) and depends only on L1+L2+L3 —
--     no prerequisite credential, no A1–A3 requirement.

-- =====================================================
-- TRACK
-- =====================================================

INSERT INTO certification_tracks (id, name, description, badge_type, certifier_group_id, sort_order) VALUES
  ('L', 'Decision-makers',
   'For brand leaders, agency executives, and SMB owners who evaluate, brief, and decide on agentic advertising but do not build agents. Three short modules on the reversed data flow, the brand-side data and governance you control, and how to decide and lead adoption. Assessed through strategic reasoning, not building. Free and open to everyone.',
   NULL, NULL, 7)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  badge_type = EXCLUDED.badge_type,
  sort_order = EXCLUDED.sort_order;

-- =====================================================
-- BADGE
-- =====================================================

-- icon reuses the 'foundations' style: this is a free, tier-1, foundational credential
-- like Basics. The badge surfaces through the API-driven certification UI.
INSERT INTO badges (id, name, description, icon, category) VALUES
  ('adcp_decision_maker', 'AdCP for Decision-Makers',
   'Strategic fluency in agentic advertising — the reversed data flow, the brand-side data and governance control surface, and how to decide and lead adoption. Earned through reasoning, not building.',
   'foundations', 'certification')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  category = EXCLUDED.category;

-- =====================================================
-- MODULES — Track L (all free, reasoning-only, no sandbox actions)
-- =====================================================

-- L1: agentic advertising and the reversed data flow
-- Maintenance note: L1 shares the agentic-vs-programmatic paradigm with foundations
-- module A1, but assesses a different competency (executive explanation of the reversed
-- data flow) with its own criterion ids and zero shared demonstrations — A1 grades a
-- hands-on live-agent query, L1 grades reasoning. If the paradigm framing changes, update
-- both A1 (migration 274) and L1 here so they do not drift.
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('L1', 'L', 'Agentic advertising and the reversed data flow',
 'What agentic advertising actually is and why it is different from programmatic — explained for a decision-maker, not a builder. No code, no live agents: you reason about the shift and learn to explain it to a CMO.',
 'interactive', 15, 1, true, '{}',
 '{
    "objectives": [
      "Explain how agentic advertising differs from programmatic in plain, executive language",
      "Describe the reversed data flow: data comes to the context instead of bid requests going out",
      "Recognize that there is no finished creative to traffic and no audience segment to buy — the buyer supplies ingredients and goals"
    ],
    "key_concepts": [
      {"topic": "The reversed data flow", "teaching_notes": "Programmatic sends a thin signal (page URL, device, maybe a user id) OUT to a remote decision-maker that lacks the conversation context. agentic advertising brings the buyer''s data — catalog, brand identity, content rules, goals — IN to the platform that already holds the context, and the platform generates the response. Ground this in the learner''s world: a CTV or social buy versus a sponsored answer in an AI assistant. Do not lecture protocol task names — this learner directs work, they do not implement it."},
      {"topic": "Explaining it to a CMO", "teaching_notes": "The common misconception is ''banner ads in AI apps.'' The accurate framing is ''the platform generates the message from our brand data, in the moment, for that conversation.'' Have the learner practice the one-paragraph version they would say to their CMO or board. Reward plain language; penalize jargon and hand-waving."},
      {"topic": "From campaigns to ingredients", "teaching_notes": "In traditional media the buyer builds creative and traffics it into placements. Here there is nothing to traffic and no segment to target — the buyer provides ingredients (products, brand voice, rules) and a goal, and the platform assembles the outcome. Contrast explicitly with the IO / creative-trafficking model the learner already knows. Better ingredients, better results."},
      {"topic": "Additive, not a rip-and-replace", "teaching_notes": "Sponsored Intelligence is a new channel that sits alongside the existing programmatic stack — it does not replace the DSP, the agency, or the measurement tools. This lowers the perceived risk and sets up the L3 pilot-vs-standardize decision."}
    ]
  }',
 '[
    {
      "id": "l1_ex1",
      "title": "Explain the shift",
      "description": "Reason through how agentic advertising differs from programmatic and practice explaining it the way you would to your CMO or board — no code, no agent queries.",
      "sandbox_actions": [],
      "success_criteria": [
        {"id": "l1_ex1_sc_reversed_data_flow", "text": "Explains the reversed data flow: programmatic sends a thin bid request OUT to a remote decision-maker that lacks conversation context, while agentic advertising brings the buyer''s data (catalog, brand identity, goals) IN to the platform that holds the context and generates the response — and states why bringing data to the context beats sending requests away from it."},
        {"id": "l1_ex1_sc_cmo_explanation", "text": "Explains to a non-technical executive (e.g. a CMO) how AI media differs from programmatic in plain language — not ''banner ads in AI apps'' but ''the platform generates the message from our brand data'' — without relying on jargon or protocol task names."},
        {"id": "l1_ex1_sc_no_creative_to_traffic", "text": "Identifies that there is no finished creative to traffic and no audience segment to buy: the buyer supplies ingredients (catalog, brand voice, rules) and a goal, and the platform assembles the outcome — and contrasts this with the insertion-order / creative-trafficking model they already know."}
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "paradigm_understanding", "weight": 35, "description": "Grasps the reversed data flow as the core distinction", "scoring_guide": {"high": "Articulates data-to-context vs request-away-from-context and why it matters, with a concrete example from their own world", "medium": "Describes the shift but misses why context location matters", "low": "Treats AI media as just another programmatic channel"}},
      {"name": "executive_communication", "weight": 35, "description": "Can translate the concept for a non-technical executive", "scoring_guide": {"high": "Delivers a clear, jargon-free one-paragraph explanation a CMO would understand and repeat", "medium": "Mostly clear but leans on jargon or hedges", "low": "Cannot explain it without protocol terms or stays abstract"}},
      {"name": "contrast_with_legacy", "weight": 20, "description": "Correctly contrasts with programmatic / IO without mismapping", "scoring_guide": {"high": "Maps the differences accurately — ingredients vs trafficked creative, goals vs targeting — and avoids false equivalences", "medium": "Partial contrast with a minor mismap", "low": "Forces AI media into the DSP/IO model"}},
      {"name": "framing_accuracy", "weight": 10, "description": "Avoids the common misconceptions", "scoring_guide": {"high": "Explicitly rejects ''banners in AI apps'' and ''rip-and-replace,'' framing it as generated and additive", "medium": "Holds one misconception lightly", "low": "Repeats a core misconception as fact"}}
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

-- L2: Your data, brand, and governance as the control surface
-- Recertification note: when AdCP 3.1 ships, update this module.
-- L2's "governance as a control dial" framing (specifically l2_ex1_sc_generation_time_brand_safety
-- and the governance_model dimension) is tied to current governance behavior. When the
-- 3.1 governance changes land (tracked in the rc.4 cycle), review and update the
-- teaching_notes for "Generation-time brand safety" and the related success criterion text.
-- The stable semantic ids (l2_ex1_sc_data_ownership, l2_ex1_sc_generation_time_brand_safety,
-- l2_ex1_sc_measurement_persists) enable targeted recertification of L2 holders at that point.
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('L2', 'L', 'Your data, brand, and governance as the control surface',
 'In agentic advertising your control comes from what you put in: brand identity as the creative voice, content standards enforced at generation time, a catalog when you advertise products, and a measurement stack that persists. Decide which levers your organization owns.',
 'interactive', 15, 2, true, '{L1}',
 '{
    "objectives": [
      "Identify the brand-side inputs your organization owns as control levers and keeps high-quality",
      "Explain generation-time brand safety as a control surface — distinct from post-hoc verification",
      "State how your existing measurement and verification stack (IAS, DV, Nielsen, MMM) persists"
    ],
    "key_concepts": [
      {"topic": "Your inputs are the dial", "teaching_notes": "Your inputs are a control dial, not a required checklist. Brand identity (voice, visual guidelines, positioning via brand.json) always shapes the output; catalogs (products, prices, descriptions, images) drive product recommendations when advertising products; content standards and conversion events are optional controls layered on for brand suitability and outcome optimization. The protocol needs very little to run a buy — do NOT present any of these as required to advertise. Where there is a catalog, input quality drives ad quality: a thin catalog produces thin product recommendations. The org owns this pipeline the way it already owns retail-media product feeds. Accept three valid ownership answers by audience: a brand owns the pipeline directly; an agency orchestrates its clients'' catalogs and brand.json on their behalf; an SMB''s existing Shopify/commerce feed already is the catalog, pushed through a partner who handles the plumbing. Tie to the learner''s context (retail-media feeds, a DAM, or a Shopify feed). If the learner asks how good their data must be before spending, frame it as a quality dial, not a gate: quality compounds in brand identity (and a catalog for product campaigns), so strengthen those first; content standards and conversion events are turn-up-when-you-want-them controls. Set a goal — what to optimize toward (target CPA, ROAS, cost-per-engagement, or reach for awareness) — so the platform knows what success means. Enrich a sparse catalog or a missing brand voice before a pilot, not after."},
      {"topic": "Generation-time brand safety", "teaching_notes": "Brands push content/suitability standards that the platform enforces WHILE the ad is generated — before anything is shown — not as a blocklist and not as post-hoc adjacency verification. It is a different control from adjacency verification, not a categorically better one: it governs how the AI represents the brand, and where content is generated on the fly and never leaves the platform it is the only workable mechanism. Frame it as ''controlling how the AI talks about your brand,'' a different problem from ''avoiding bad adjacency.'' Do not have the learner claim it is simply stronger than IAS/DV. Legal/regulatory compliance (COPPA, GDPR, HFSS) is enforced automatically by governance agents via the Policy Registry, independent of what the brand pushes; content standards are the brand''s OPTIONAL, brand-specific control on top — never present them as required to advertise or as the legal backstop."},
      {"topic": "Your measurement stack carries over", "teaching_notes": "The org keeps its measurement contracts and accreditations (IAS, DV, Nielsen, Comscore) and evaluates this channel with the same frameworks (MMM, MTA, incrementality). AdCP is not an MRC-accredited measurement standard; it carries the delivery and usage data those tools consume. What adapts: pushing conversion events lets platforms optimize toward real business outcomes instead of proxy metrics, and on ephemeral AI-generated surfaces the classic ''send the page to IAS/DV'' adjacency check shifts to the content-standards calibration model — the contract persists, the mechanism adapts. For an SMB without measurement vendors, ''carries over'' means their existing ROAS/CPA tracking in platform dashboards and their conversion pixel still work — they are not required to hold IAS/DV/Nielsen contracts. Reassure the risk-averse executive: this is not a leap of faith."}
    ]
  }',
 '[
    {
      "id": "l2_ex1",
      "title": "Identify the inputs you control",
      "description": "Reason about the brand-side data, brand, and governance inputs you provide as control levers, and how your existing measurement persists — no code, no agent queries.",
      "sandbox_actions": [],
      "success_criteria": [
        {"id": "l2_ex1_sc_data_ownership", "text": "Identifies the inputs the organization owns as control levers, not a fixed checklist — brand identity (voice, visual guidelines, positioning) always shapes the output; a catalog and conversion events come in for product and outcome-optimized campaigns; a clear goal says what success is — and explains that input quality drives ad quality (a thin catalog produces thin product recommendations, while a brand-awareness campaign needs no catalog)."},
        {"id": "l2_ex1_sc_generation_time_brand_safety", "text": "Explains generation-time brand safety as control: the brand pushes content/suitability standards that the platform enforces while the ad is generated, giving control over how the AI represents the brand that no post-hoc check provides — and, where content is generated on the fly and never leaves the platform, is the only workable mechanism — and distinguishes this from a blocklist or a third-party bolt-on."},
        {"id": "l2_ex1_sc_measurement_persists", "text": "States how the organization keeps its existing measurement contracts and accreditations (e.g. IAS, DV, Nielsen, MMM, multi-touch attribution, incrementality) and evaluates this channel with the same frameworks — Sponsored Intelligence is a new channel in the media plan, not a new measurement paradigm — while naming what adapts: pushing conversion events lets platforms optimize toward real outcomes, and on ephemeral AI-generated surfaces third-party suitability verification shifts to the content-standards calibration model."}
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "data_ownership_clarity", "weight": 35, "description": "Identifies the inputs the org owns as control levers", "scoring_guide": {"high": "Names the inputs they own as levers — brand identity always; a catalog and conversion events for product/outcome campaigns; a clear goal for what success is — explains input quality drives ad quality, and recognizes none is a required checklist (a brand-awareness campaign needs no catalog)", "medium": "Names some inputs but misses the quality link or who owns them", "low": "Assumes the agency or platform owns the data, or that a catalog is always required"}},
      {"name": "governance_model", "weight": 30, "description": "Understands generation-time brand safety as control", "scoring_guide": {"high": "Explains enforcement during generation as control over how the AI represents the brand — distinct from adjacency verification rather than categorically better — and contrasts it with a blocklist", "medium": "Knows brand safety is built in but fuzzy on the generation-time distinction", "low": "Treats it as nothing more than a blocklist, or assumes it simply replaces third-party adjacency verification"}},
      {"name": "measurement_continuity", "weight": 25, "description": "Knows measurement contracts persist and what adapts", "scoring_guide": {"high": "States the org keeps its measurement contracts/accreditations and evaluation frameworks (IAS/DV/Nielsen/MMM/attribution) — or, for an SMB without vendors, that their ROAS/CPA dashboards and conversion tracking still work — and identifies what adapts: conversion-event optimization, and calibration-based suitability on AI-generated surfaces", "medium": "Believes measurement mostly carries over but is unsure what changes", "low": "Assumes AI media needs a new measurement paradigm"}},
      {"name": "org_application", "weight": 10, "description": "Connects the control surface to their own organization", "scoring_guide": {"high": "Maps the inputs to who owns each in their context — a brand''s own teams, the clients'' feeds an agency orchestrates, or an SMB''s commerce feed plus a partner", "medium": "Makes the connection when prompted", "low": "Keeps it abstract"}}
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

-- L3: Deciding and leading (capstone)
-- Capstone enforcement: L3 is the capstone of the Decision-Makers track. Sage is
-- instructed (via DECISION_ARTIFACT_CAPSTONE_SUPPLEMENT in certification-tools.ts)
-- to require the learner to produce an actual decision artifact before completing
-- the module — a business case, agency brief, or phased adoption plan. Fluent
-- discussion alone is not sufficient. format stays 'interactive' (this is not a
-- specialist capstone/lab); the enforcement is in the Sage prompt layer.
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria) VALUES
('L3', 'L', 'Deciding and leading',
 'Make the call and lead your organization: brief an agency or in-house team, decide pilot-vs-standardize given a surface''s maturity, and produce a decision artifact — a business case, an agency brief, or a phased adoption plan. The capstone is a decision, not a build.',
 'interactive', 15, 3, true, '{L2}',
 '{
    "objectives": [
      "Brief an agency or in-house team on what the brand provides versus what to expect back",
      "Decide pilot-vs-standardize for a given surface and justify it on reversibility and risk",
      "Produce a role-appropriate decision artifact: a business case, an agency brief, or a phased adoption plan"
    ],
    "key_concepts": [
      {"topic": "Briefing the people who execute", "teaching_notes": "The decision-maker''s job is the brief, not the build. Division of labor: the brand provides catalogs, brand.json, content standards, and goals; the agency or in-house team runs campaigns across AI surfaces and reports delivery. Frame it as additive to existing agency relationships and the programmatic stack — the agency''s buyer agent sits alongside the DSP. Many agencies are still figuring AI media out, so the brief has to be specific about inputs. For an SMB with no agency, ''briefing'' is choosing a partner (an ad network or a Shopify-type app) and telling them three things: the product feed, the budget, and the goal."},
      {"topic": "Pilot vs standardize", "teaching_notes": "When a surface is experimental, pilot one surface with one agency to learn cheaply and reversibly. Once value is proven, standardize on the protocol so one integration reaches many surfaces instead of negotiating direct deals platform by platform. Reason about reversibility and risk, not hype. Some surfaces (e.g. Sponsored Intelligence) are explicitly experimental and may change — that is an input to the decision, not a reason to wait on everything."},
      {"topic": "The decision artifact", "teaching_notes": "Culminate in an artifact appropriate to the learner''s role: a brand leader writes a business case for the CMO; an agency exec writes a client-facing adoption recommendation or internal capability plan; an SMB owner writes a phased plan (find a partner, connect the feed, start small). It must tie together the economics and competitive case, org-readiness (who owns the data pipeline), and a concrete next step. This is strategy, not a build spec — never ask the learner to write code or schemas."},
      {"topic": "Economics and the competitive case", "teaching_notes": "Pricing differs from programmatic auctions (e.g. cost-per-click on sponsored answers, per-session for conversational experiences) and is set per platform — the learner should grasp it is not a single fixed rate and reason at the level of ''what would make this worth it.'' For learners who know programmatic, ''not a fixed RTB auction'' is a useful analogy — do not require the term, and do not grade a non-technical learner on it. Competitive case (a tradeoff to weigh, not a guarantee): brands and agencies with rich brand data and a working buying path can reach AI-surface demand faster than peers negotiating one-off direct deals platform by platform. Give the learner a way to reason about a pilot budget without quoting prices: size a pilot they can write off as learning, pick one surface and one success metric, discover actual pricing per platform (from the seller''s products or a partner), and compare cost-per-outcome against their existing channel benchmark. For ''is anyone else doing this,'' characterize the landscape by surface maturity (experimental versus live) and how many sellers are reachable today through the registry — do not assert specific competitors or adoption numbers. For an agency learner, the economics question is their own P&L: managed-service (mark up media + a service fee) vs self-serve (charge for setup and strategy); the margin comes from one integration collapsing per-platform labor, not from negotiating rate cards. Use placeholder numbers the learner supplies — never quote market rates."}
    ]
  }',
 '[
    {
      "id": "l3_ex1",
      "title": "Make the call and lead the organization",
      "description": "Reason through how you would brief your team, decide pilot-vs-standardize, and produce a decision artifact for your role — no code, no agent queries.",
      "sandbox_actions": [],
      "success_criteria": [
        {"id": "l3_ex1_sc_brief_agency", "text": "Briefs an agency or in-house team on the division of labor: what the brand provides (catalogs, brand.json, content standards, goals) versus what to expect back (campaigns across AI surfaces, delivery reporting) — and frames it as additive to existing agency relationships and the programmatic stack, not a replacement."},
        {"id": "l3_ex1_sc_pilot_vs_standardize", "text": "Given a surface''s maturity (experimental versus established), decides pilot-vs-standardize and justifies it: pilot one surface with one agency to learn cheaply when a surface is experimental; standardize on the protocol once value is proven so one integration reaches many surfaces — reasoning about reversibility and risk rather than hype."},
        {"id": "l3_ex1_sc_decision_artifact", "text": "Produces a decision artifact appropriate to their role — a business case, an agency brief, or a phased adoption plan — that ties together the economics and competitive case, org-readiness (who owns the data pipeline), and a concrete next step. The artifact is strategic, not a build specification."}
      ]
    }
  ]',
 '{
    "dimensions": [
      {"name": "leadership_brief", "weight": 30, "description": "Can brief an agency or team on inputs versus expectations", "scoring_guide": {"high": "Specifies what the brand provides and what to expect back, and frames it as additive to existing relationships and stack", "medium": "Covers the brief but vague on the division of labor", "low": "Delegates wholesale (''the agency will figure it out'') with no inputs named"}},
      {"name": "decision_reasoning", "weight": 35, "description": "Reasons about pilot-vs-standardize on risk and reversibility", "scoring_guide": {"high": "Chooses pilot or standardize for a given surface and defends it on reversibility, risk, and a surface''s experimental status", "medium": "Makes a defensible call but thin justification", "low": "Decides on hype or defers entirely"}},
      {"name": "decision_artifact", "weight": 25, "description": "Produces a coherent, role-appropriate decision artifact", "scoring_guide": {"high": "Delivers a business case, agency brief, or phased plan tying economics, org-readiness, and a concrete next step", "medium": "Artifact is partial or missing one element", "low": "No usable artifact, or drifts into build/spec territory"}},
      {"name": "competitive_economics", "weight": 10, "description": "Reasons about economics and the competitive case", "scoring_guide": {"high": "Reasons that pricing is set per platform rather than a single fixed rate, and weighs the competitive tradeoff — standardize once to reach many surfaces versus per-platform direct deals, and the time-to-reach that implies", "medium": "Touches economics or competition but not both", "low": "No economic or competitive reasoning"}}
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
-- CREDENTIAL
-- =====================================================

INSERT INTO certification_credentials (id, tier, name, description, required_modules, requires_any_track_complete, requires_credential, badge_id, certifier_group_id, sort_order) VALUES
  ('decision_makers', 1, 'AdCP for Decision-Makers',
   'Strategic fluency in agentic advertising for brand leaders, agency executives, and SMB owners — earned through reasoning, not building. Covers the reversed data flow, the brand-side data and governance you control, and how to decide and lead adoption. It certifies strategic fluency, not hands-on implementation: it is not a substitute for, or an easier route to, the Basics or Practitioner credentials. Free and open to everyone; no agent-building required.',
   '{L1,L2,L3}', false, NULL, 'adcp_decision_maker', NULL, 8)
ON CONFLICT (id) DO UPDATE SET
  tier = EXCLUDED.tier,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  required_modules = EXCLUDED.required_modules,
  requires_any_track_complete = EXCLUDED.requires_any_track_complete,
  requires_credential = EXCLUDED.requires_credential,
  badge_id = EXCLUDED.badge_id,
  certifier_group_id = EXCLUDED.certifier_group_id,
  sort_order = EXCLUDED.sort_order;
