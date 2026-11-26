-- Bring the Academy curriculum up to AdCP 3.3 GA.
--
-- Corrections to content that teaches superseded behaviour:
--   * Version negotiation (A2, B1, C1) taught only adcp_major_version. Since
--     3.1 buyers pin a release with adcp_version and sellers list and echo
--     releases; from 3.3 a major-only request is served the oldest release in
--     that major, discovery is sent unpinned, and VERSION_UNSUPPORTED is
--     retried without a pin or at a listed release.
--   * Accounts (A3, B3, C1, D1, S1, S7) taught the {brand, operator} natural
--     key as the reference on every call. From 3.3 sync_accounts returns an
--     account_id that every later call uses, discovery never provisions an
--     account, and the natural key as a reference after provisioning is
--     deprecated.
--   * Buying (A2, A3, C1) taught get_products and create_media_buy as the only
--     path and the 3.0 "refinement protocol". Both tasks are deprecated for new
--     integrations since 3.2 (still supported through 3.x); new integrations
--     use list_products, request_proposals, refine_proposals, buy_products, and
--     accept_proposal. C1 also listed a "package" tool that does not exist.
--   * Campaign governance (D2, S4) taught a check_governance "binding"
--     parameter, an "escalated" verdict, and governance_agents on
--     sync_accounts. The check type is inferred from the request (intent or
--     execution), the verdict is approved, denied, or conditions, and the
--     governance agent is registered with sync_governance.
--   * D4 graded a recovery_type field; the error field is recovery.
--   * A2B taught tight polling only; 3.3 adds expected_confirmation_at.
--   * S2's tracker-slot criterion implied a format without a tracker slot
--     cannot carry third-party measurement; from 3.3 such a format makes no
--     slot claim.
-- New 3.3 material is added as key concepts in S1, B3, D1, S2, S3, S4, S6, and
-- S7. It is taught, not graded: no success criterion is added, so learners
-- mid-module are not blocked by new requirements.
--
-- Criterion IDs are unchanged: teaching checkpoints store them in
-- demonstrations_verified and demonstration_evidence, and completion requires
-- every current ID. Historical migrations stay unchanged.

CREATE OR REPLACE FUNCTION _c33_replace_criterion_text(
  p_module_id text,
  p_exercise_id text,
  p_criterion_id text,
  p_text text
) RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  criterion jsonb;
  criteria jsonb;
  criterion_matched boolean := false;
BEGIN
  SELECT exercise_definitions INTO defs
  FROM certification_modules
  WHERE id = p_module_id;

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module % not found or has no exercise_definitions array', p_module_id;
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = p_exercise_id THEN
      criteria := '[]'::jsonb;
      FOR criterion IN SELECT * FROM jsonb_array_elements(COALESCE(ex->'success_criteria', '[]'::jsonb))
      LOOP
        IF criterion->>'id' = p_criterion_id THEN
          criterion_matched := true;
          criterion := jsonb_set(criterion, '{text}', to_jsonb(p_text));
        END IF;
        criteria := criteria || jsonb_build_array(criterion);
      END LOOP;
      ex := jsonb_set(ex, '{success_criteria}', criteria);
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT criterion_matched THEN
    RAISE EXCEPTION 'Criterion % not found in exercise % of module %', p_criterion_id, p_exercise_id, p_module_id;
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

-- Replace one passage inside a criterion. Idempotent: a criterion that
-- already carries the replacement is left alone.
CREATE OR REPLACE FUNCTION _c33_replace_criterion_passage(
  p_module_id text,
  p_exercise_id text,
  p_criterion_id text,
  p_old text,
  p_new text
) RETURNS void AS $$
DECLARE
  current_text text;
BEGIN
  SELECT criterion->>'text' INTO current_text
  FROM certification_modules m,
    jsonb_array_elements(m.exercise_definitions) ex,
    jsonb_array_elements(COALESCE(ex->'success_criteria', '[]'::jsonb)) criterion
  WHERE m.id = p_module_id
    AND ex->>'id' = p_exercise_id
    AND criterion->>'id' = p_criterion_id;

  IF current_text IS NULL THEN
    RAISE EXCEPTION 'Criterion % not found in exercise % of module %', p_criterion_id, p_exercise_id, p_module_id;
  END IF;
  IF position(p_new IN current_text) > 0 THEN
    RETURN;
  END IF;
  IF position(p_old IN current_text) = 0 THEN
    RAISE EXCEPTION 'Criterion % does not contain the passage to replace', p_criterion_id;
  END IF;

  PERFORM _c33_replace_criterion_text(p_module_id, p_exercise_id, p_criterion_id,
    replace(current_text, p_old, p_new));
END;
$$ LANGUAGE plpgsql;

-- Replace a key concept's topic and teaching notes, found by its old or new
-- topic so the call is idempotent.
CREATE OR REPLACE FUNCTION _c33_set_key_concept(
  p_module_id text,
  p_old_topic text,
  p_new_topic text,
  p_teaching_notes text
) RETURNS void AS $$
DECLARE
  plan jsonb;
  concepts jsonb := '[]'::jsonb;
  concept jsonb;
  concept_matched boolean := false;
BEGIN
  SELECT lesson_plan INTO plan
  FROM certification_modules
  WHERE id = p_module_id;

  IF plan IS NULL OR jsonb_typeof(plan->'key_concepts') <> 'array' THEN
    RAISE EXCEPTION 'Module % not found or has no key_concepts array', p_module_id;
  END IF;

  FOR concept IN SELECT * FROM jsonb_array_elements(plan->'key_concepts')
  LOOP
    IF concept->>'topic' IN (p_old_topic, p_new_topic) THEN
      concept_matched := true;
      concept := concept
        || jsonb_build_object('topic', p_new_topic, 'teaching_notes', p_teaching_notes);
    END IF;
    concepts := concepts || jsonb_build_array(concept);
  END LOOP;

  IF NOT concept_matched THEN
    RAISE EXCEPTION 'Key concept "%" not found in module %', p_old_topic, p_module_id;
  END IF;

  UPDATE certification_modules
  SET lesson_plan = jsonb_set(plan, '{key_concepts}', concepts)
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

-- Replace one passage inside a key concept's teaching notes. Idempotent.
CREATE OR REPLACE FUNCTION _c33_replace_concept_passage(
  p_module_id text,
  p_topic text,
  p_old text,
  p_new text
) RETURNS void AS $$
DECLARE
  notes text;
BEGIN
  SELECT concept->>'teaching_notes' INTO notes
  FROM certification_modules m,
    jsonb_array_elements(m.lesson_plan->'key_concepts') concept
  WHERE m.id = p_module_id
    AND concept->>'topic' = p_topic;

  IF notes IS NULL THEN
    RAISE EXCEPTION 'Key concept "%" not found in module %', p_topic, p_module_id;
  END IF;
  IF position(p_new IN notes) > 0 THEN
    RETURN;
  END IF;
  IF position(p_old IN notes) = 0 THEN
    RAISE EXCEPTION 'Key concept "%" in module % does not contain the passage to replace', p_topic, p_module_id;
  END IF;

  PERFORM _c33_set_key_concept(p_module_id, p_topic, p_topic, replace(notes, p_old, p_new));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _c33_append_key_concept(
  p_module_id text,
  p_topic text,
  p_teaching_notes text
) RETURNS void AS $$
DECLARE
  plan jsonb;
  concepts jsonb;
BEGIN
  SELECT lesson_plan INTO plan
  FROM certification_modules
  WHERE id = p_module_id;

  IF plan IS NULL OR jsonb_typeof(plan) <> 'object' THEN
    RAISE EXCEPTION 'Module % not found or has no lesson_plan object', p_module_id;
  END IF;

  concepts := COALESCE(plan->'key_concepts', '[]'::jsonb);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(concepts) concept
    WHERE concept->>'topic' = p_topic
  ) THEN
    RETURN;
  END IF;

  UPDATE certification_modules
  SET lesson_plan = jsonb_set(
    plan,
    '{key_concepts}',
    concepts || jsonb_build_array(
      jsonb_build_object('topic', p_topic, 'teaching_notes', p_teaching_notes)
    )
  )
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

-- Replace the sandbox action for one tool in an exercise. Idempotent: found by
-- the old or the new tool name.
CREATE OR REPLACE FUNCTION _c33_replace_sandbox_action(
  p_module_id text,
  p_exercise_id text,
  p_old_tool text,
  p_new_tool text,
  p_guidance text
) RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  actions jsonb;
  action jsonb;
  matches integer := 0;
BEGIN
  SELECT exercise_definitions INTO defs
  FROM certification_modules
  WHERE id = p_module_id;

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module % not found or has no exercise_definitions array', p_module_id;
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = p_exercise_id THEN
      actions := '[]'::jsonb;
      FOR action IN SELECT * FROM jsonb_array_elements(COALESCE(ex->'sandbox_actions', '[]'::jsonb))
      LOOP
        IF action->>'tool' = p_old_tool
          OR (action->>'tool' = p_new_tool AND action->>'guidance' = p_guidance) THEN
          matches := matches + 1;
          action := jsonb_build_object('tool', p_new_tool, 'guidance', p_guidance);
        END IF;
        actions := actions || jsonb_build_array(action);
      END LOOP;
      ex := jsonb_set(ex, '{sandbox_actions}', actions);
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one % sandbox action in exercise % of module %, found %',
      p_old_tool, p_exercise_id, p_module_id, matches;
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Version negotiation
-- ---------------------------------------------------------------------------

SELECT _c33_replace_criterion_text('A2', 'a2_ex1', 'a2_ex1_sc_version_negotiation',
  'Explains how a buyer and a seller agree on a release: the seller lists the releases it serves in get_adcp_capabilities (adcp.supported_versions, with adcp.major_versions for older clients), the buyer pins one with adcp_version (a release such as "3.2" or "3.3") and mirrors its major in adcp_major_version during 3.x, and the seller echoes the release it actually served. On VERSION_UNSUPPORTED the buyer retries without a pin or at a release the error lists. Naming every field is not required.');

SELECT _c33_replace_criterion_text('B1', 'b1_ex1', 'b1_ex1_sc_version_negotiation',
  'Sales agent lists the releases it serves in get_adcp_capabilities (adcp.supported_versions at release precision, such as "3.3", alongside adcp.major_versions), echoes the served release in adcp_version on every response and shapes the response to it, serves a request that carries only adcp_major_version at the oldest release it supports in that major, and returns VERSION_UNSUPPORTED listing its supported_versions when it cannot serve the pin.');

SELECT _c33_replace_criterion_text('C1', 'c1_ex1', 'c1_ex1_sc_version_declaration',
  'Sends the discovery get_adcp_capabilities call without a pin, then pins create_media_buy and other requests with adcp_version (a release the seller lists, such as "3.2" or "3.3") and the adcp_major_version mirror, sends a prerelease pin only to a seller that lists it exactly, validates each response against the release the seller echoes, and on VERSION_UNSUPPORTED retries without a pin or at a release the error lists.');

-- ---------------------------------------------------------------------------
-- Account identity
-- ---------------------------------------------------------------------------

SELECT _c33_replace_concept_passage('A3', 'Accounts and billing',
  'sync_accounts establishes billing relationships, list_accounts manages them.',
  'sync_accounts opens accounts and establishes billing relationships, and returns an account_id that every later call uses; list_accounts lists them.');

SELECT _c33_set_key_concept('B3', 'Account management', 'Account management',
  $notes$sync_accounts provisions buyer accounts: billing model (operator-billed or agent-billed), credit limits, and status. list_accounts lists them. From 3.3, return an account_id from sync_accounts once the account is resolved, accept it on every account-scoped task, and never change it. Countries, currency, timezone, sandbox, and operator_unit are attributes of the account, so changing one never changes the account. Discovery and negotiation tasks never create or activate an account. A {brand, operator} natural key still opens an account and still resolves through 3.x, but using it as the reference after provisioning is deprecated for 4.0. This is the commercial infrastructure.$notes$::text);

SELECT _c33_set_key_concept('D1', 'Capability and account handling', 'Capability and account handling',
  $notes$get_adcp_capabilities advertises what your server supports: targeting, reporting, features, and the releases you serve. Serve it without credentials (SHOULD in 3.3, MUST in 4.0) so a new counterparty can read it first. sync_accounts handles account setup from buyers: provisioning billing, setting credit limits, and returning account status and an account_id that every later call uses and that never changes. Discovery tasks such as list_products never provision an account. These are the handshake tasks.$notes$::text);

SELECT _c33_set_key_concept('C1', 'Account and audience setup', 'Account and audience setup',
  $notes$Before buying, establish billing with sync_accounts: choose operator-billed or agent-billed. Store the account_id the seller returns and send it on every later call; the {brand, operator} natural key opens the account, but referencing an account by its natural key after provisioning is deprecated in 3.3. Sync custom audience segments with sync_audiences so sellers can target your users. This is the setup work that makes buying possible.$notes$::text);

SELECT _c33_replace_criterion_text('C1', 'c1_ex1', 'c1_ex1_sc_update_media_buy_account',
  'Includes account on every update_media_buy call, referencing the account by the account_id the seller returned, so billing resolves to the correct relationship.');

SELECT _c33_replace_criterion_text('S1', 's1_ex1', 's1_ex1_sc_update_media_buy_account',
  'Calls update_media_buy with account + media_buy_id (both required since 3.0), referencing the account by the account_id the seller returned; omitting account is a protocol error.');

SELECT _c33_replace_concept_passage('S7', 'Organizational hierarchy: two axes, and where operators fit',
  'The operator axis surfaces at runtime in the Accounts Protocol: every action carries an account whose natural key is {brand, operator} (operator = the domain of the entity operating the account; equals the brand''s own domain when the brand operates directly). The seller''s require_operator_auth capability selects the reference shape — true = seller-assigned account_id namespaces with independent operator auth (use list_accounts); false = buyer-declared {brand, operator} pairs provisioned via sync_accounts.',
  'The operator axis surfaces at runtime in the Accounts Protocol: an account is opened for a {brand, operator} pair (operator = the domain of the entity operating the account; equals the brand''s own domain when the brand operates directly), and every later action references it by the seller''s account_id. The seller''s require_operator_auth capability says who authenticates and how accounts are opened — true = each operator authenticates and finds its seller-assigned account_id values with list_accounts; false = the buyer agent is trusted and opens buyer-declared accounts with sync_accounts, which returns the account_id. Referencing an account by its natural key after provisioning still works in 3.x but is deprecated from 3.3.');

SELECT _c33_replace_criterion_passage('S7', 's7_ex1', 's7_ex1_sc_operator_authorization',
  'and reasons about how the seller''s require_operator_auth selects the {brand, operator} natural-key vs seller-assigned account_id reference shape.',
  'and reasons about what the seller''s require_operator_auth selects: who authenticates (the buyer agent or each operator) and how accounts are opened (buyer-declared through sync_accounts or seller-assigned through list_accounts), with every later call referencing the account_id.');

-- ---------------------------------------------------------------------------
-- Buying: the compact lifecycle, and no "package" tool
-- ---------------------------------------------------------------------------

SELECT _c33_append_key_concept('A2', 'Two ways to buy',
  $notes$After the demo, say once that it used get_products and create_media_buy, the original buying tasks. They stay fully supported through 3.x, but since 3.2 new integrations use the compact lifecycle: list_products or request_proposals to discover, refine_proposals to negotiate, then buy_products or accept_proposal to buy, with control_media_buy for changes inside the agreed terms. A seller lists the tasks it offers in lifecycle_tools on get_adcp_capabilities. Mention it; don't re-run the demo with the new tasks, and don't grade it.$notes$::text);

SELECT _c33_set_key_concept('A3', 'Media buy beyond the basics', 'Media buy beyond the basics',
  $notes$A2 covered the basic lifecycle. There's much more: proposals with delivery forecasts and budget points (request_proposals), negotiation with refine_proposals, holds on committed proposals, keyword and geo-proximity targeting, and the compact lifecycle that new integrations use (list_products, buy_products, accept_proposal, control_media_buy). Tasks: request_proposals, refine_proposals, accept_proposal, get_media_buys, update_media_buy. Keep this at survey depth.$notes$::text);

SELECT _c33_set_key_concept('C1', 'Proposals and packages', 'Proposals and packages',
  $notes$request_proposals returns priced proposals built from packages, with budget points and forecasts (estimate, modeled, guaranteed). refine_proposals revises them and finalizes the one you want; accept_proposal buys it, and buy_products buys listed products directly. After the buy, update_media_buy changes it (control_media_buy on the compact lifecycle). get_products and create_media_buy stay supported through 3.x as the compatibility path. This is how negotiation works in AdCP.$notes$::text);

SELECT _c33_replace_sandbox_action('C1', 'c1_ex1', 'package', 'request_proposals',
  'Request proposals for the same brief and compare their packages, budget points, and forecasts.');

DO $$
DECLARE
  plan jsonb;
BEGIN
  SELECT lesson_plan INTO plan
  FROM certification_modules
  WHERE id = 'C1';

  IF plan IS NULL OR jsonb_typeof(plan->'demo_scenarios') <> 'array' THEN
    RAISE EXCEPTION 'Module C1 not found or has no demo_scenarios array';
  END IF;

  UPDATE certification_modules
  SET lesson_plan = jsonb_set(plan, '{demo_scenarios}', COALESCE((
    SELECT jsonb_agg(
      CASE WHEN scenario->'tools' = '["package"]'::jsonb
        THEN jsonb_build_object(
          'tools', jsonb_build_array('request_proposals'),
          'description', 'Proposal and package exploration',
          'expected_outcome', 'See proposals built from packages, with budget points and forecasts for planning'
        )
        ELSE scenario
      END ORDER BY ordinality)
    FROM jsonb_array_elements(plan->'demo_scenarios') WITH ORDINALITY AS s(scenario, ordinality)
  ), '[]'::jsonb))
  WHERE id = 'C1';
END;
$$;

-- ---------------------------------------------------------------------------
-- Async confirmation and errors
-- ---------------------------------------------------------------------------

SELECT _c33_replace_concept_passage('A2B', 'Async polling with tasks/get',
  'builds the muscle memory.',
  'builds the muscle memory. From 3.3 a submitted response may carry expected_confirmation_at, when a booking round or manual review is expected to finish. When it is present, check status at that time instead of polling every few seconds; it is an estimate, not a commitment.');

SELECT _c33_replace_concept_passage('D4', 'Phase 3: Validate (~10 min)',
  'Check that error responses include recovery_type (transient/correctable/terminal).',
  'Check that error responses include recovery (transient, correctable, or terminal), and that an error ending a state-changing request can say whether the change applied with mutation_outcome (not_applied, unknown, or applied; new in 3.3).');

SELECT _c33_replace_criterion_text('D4', 'd4_validate', 'd4_validate_sc2',
  'Error responses include recovery (transient, correctable, or terminal) and meaningful messages');

-- ---------------------------------------------------------------------------
-- Campaign governance: inferred check type, three verdicts, sync_governance
-- ---------------------------------------------------------------------------

SELECT _c33_set_key_concept('D2', 'Campaign governance architecture', 'Campaign governance architecture',
  $notes$Platform builders implement the three-party validation flow. A buyer registers its governance agent for an account with sync_governance; the binding is per account, and the seller calls that agent during governed lifecycle events. The platform needs to: store the governance agent per account, call check_governance with the committed action and the governance_context before executing media buys on accounts that have one (an execution check), and act on the verdict: approved, denied, or conditions (conditions only on intent checks). Escalation to a human is the governance agent's process and shows in its findings, not a fourth verdict. Cover governance modes (audit, advisory, enforce) as an adoption path; mode is the governance agent's configuration, not a request field. Reference the campaign governance specification.$notes$::text);

SELECT _c33_set_key_concept('S4', 'Campaign governance protocol', 'Campaign governance protocol',
  $notes$Core tasks: sync_plans, check_governance, report_plan_outcome, and get_plan_audit_logs; report_plan_adjustment appends a later seller adjustment to a completed outcome, and sync_governance registers an account's governance agent. The campaign plan defines authorized parameters: budget, channels, flight dates, markets. check_governance infers the check type from the request: tool plus payload is an intent check (the orchestrator's proposed action, which may return conditions), and planned_delivery or delivery_metrics with governance_context is an execution check (the seller's committed action, approved or denied). The verdict is in verdict. Budget is committed on confirmed outcomes, not intent. Cover the full loop with the lab exercise. Reference the campaign governance overview and task reference docs.$notes$::text);

DO $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  actions jsonb;
  action jsonb;
  matched boolean := false;
  new_guidance text := 'Send intent checks (tool plus payload: the orchestrator''s proposed action) for a valid action, which should approve, and an invalid one, which should deny or return conditions. Test at least two validation categories.';
BEGIN
  SELECT exercise_definitions INTO defs
  FROM certification_modules
  WHERE id = 'S4';

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module S4 not found or has no exercise_definitions array';
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = 'e4_ex2' THEN
      actions := '[]'::jsonb;
      FOR action IN SELECT * FROM jsonb_array_elements(COALESCE(ex->'sandbox_actions', '[]'::jsonb))
      LOOP
        IF action->>'tool' = 'check_governance'
          AND (action->>'guidance' LIKE 'Call with binding proposed%' OR action->>'guidance' = new_guidance) THEN
          matched := true;
          action := jsonb_set(action, '{guidance}', to_jsonb(new_guidance));
        END IF;
        actions := actions || jsonb_build_array(action);
      END LOOP;
      ex := jsonb_set(ex, '{sandbox_actions}', actions);
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT matched THEN
    RAISE EXCEPTION 'S4 e4_ex2 check_governance sandbox action not found';
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = 'S4';
END;
$$;

SELECT _c33_replace_criterion_text('S4', 'e4_ex2', 'e4_ex2_sc1',
  'Demonstrates the difference between an intent check (the orchestrator''s proposed action, sent as tool plus payload; may return conditions) and an execution check (the seller''s committed action, sent with governance_context; approved or denied)');

SELECT _c33_append_key_concept('S4', 'AdCP 3.3 governance updates',
  $notes$A campaign plan can split its budget by time with budget.periods[] (experimental; governance agents declare governance.supports_budget_periods): check_governance denies a dated action that straddles a period, sits in unallocated budget, or overruns its period. A sync_plans plan may omit human_review_required; the governance agent derives it from the plan's policies and rejects a caller-supplied false when a policy requires human review, and plans that require it escalate in every mode. A sync that cuts budget.total below committed spend is rejected with VALIDATION_ERROR. A caller that fails approved_sellers or delegations gets a denied verdict with a finding; PERMISSION_DENIED is for a missing or mismatched identity. Property list references resolve through AdCP: the issuer exposes get_property_list and accepts the reference's list-scoped token. Teach these; they are not graded.$notes$::text);

-- ---------------------------------------------------------------------------
-- Creative: tracker slots
-- ---------------------------------------------------------------------------

SELECT _c33_replace_criterion_text('S2', 's2_ex1', 's2_ex1_sc_tracker_slot_reasoning',
  'Determines what a format says about third-party measurement by inspecting its assets array for tracker slots — slot limits apply only when the effective format declares at least one, and a format that declares none makes no slot claim — and explains why broadcast formats omit tracker slots and rely on billing_measurement vendors instead.');

-- ---------------------------------------------------------------------------
-- New in 3.3: taught, not graded
-- ---------------------------------------------------------------------------

SELECT _c33_append_key_concept('S1', 'AdCP 3.3 scheduled and human-gated buying',
  $notes$A submitted create_media_buy, buy_products, or accept_proposal can carry expected_confirmation_at: check status then instead of polling tightly. A provisional buy (confirmed_at: null) stays pending_start until the seller confirms or rejects it and never activates on its own at flight start; sales-fixed-rate is the stable specialism for fixed-price sellers that reserve no inventory. An outcome_target goal can name a vendor metric (kind: vendor_metric, such as store visits measured by a foot-traffic vendor). The media-buy revision advances on every committed change from any origin, so a stale revision gets CONFLICT: re-read and retry. A failed state-changing request can say whether it applied with mutation_outcome. Experimental, survey only: hold_policy and extend_hold, list_proposals and later proposals, seller offers, renewal lineage, delivery projection, and spot lifecycle for linear TV. None of this is graded yet.$notes$::text);

SELECT _c33_append_key_concept('B3', 'AdCP 3.3 delivery reporting',
  $notes$From 3.3 a delivery row may omit impressions the seller did not measure (a row of plays or downloads), but only toward callers pinned at 3.3 or later; receivers never read absence as zero. Return at least one by_package row per package of each media buy on get_media_buy_delivery, and an error rather than an empty by_package for a buy you can't report. Echo reporting_webhook.operation_id on every delivery webhook, and send none to a registration that omits it. A seller that declares supports_property_breakdown returns by_property on every product with the per-product flag. Experimental, survey only: delivery projection, installment lifecycle and proof of publication, print proof of insertion and circulation, and DOOH impression basis. Not graded.$notes$::text);

SELECT _c33_append_key_concept('D1', 'AdCP 3.3 server rules',
  $notes$On MCP, a gateway that allow-lists methods should let server/discover, initialize, and tools/list through without credentials, beside an anonymous get_adcp_capabilities. Keep those discovery responses small: they are the first bytes a counterparty reads, and an oversized one makes your agent unreachable. Clients bound what they read (4 MiB by default in 3.3). Shape each response to the release you served, and emit only properties that release defines, apart from ext.{namespace}. Teach these; they are not graded.$notes$::text);

SELECT _c33_append_key_concept('S2', 'AdCP 3.3 creative assignment',
  $notes$A 3.3 seller lists the sync_creatives assignment_operations it accepts (assign, unassign, replace, merge) in creative.assignment_operations. The list is exact: it rejects anything else with UNSUPPORTED_FEATURE, and a buyer sends only listed operations, or none to a 3.3 seller that lists none. replace carries the replaced assignment's weight, routing, trackers, and landing-page override to the replacement, or the request is rejected. Sellers that declare creative.supports_assignment_trackers or supports_assignment_landing_page accept per-assignment trackers or a landing_page_url. pixel_tracker events add start, first_quartile, midpoint, third_quartile, and complete for hosted video and audio. Live creative updates (creative.live_updates) are experimental. Teach these; only the tracker-slot rule is graded.$notes$::text);

SELECT _c33_append_key_concept('S3', 'AdCP 3.3 signals and audience updates',
  $notes$sync_event_sources and sync_audiences results name the seller's ID for the object platform_id. A 3.3 seller sends it beside the deprecated seller_id alias with the same value, and buyers prefer platform_id. sync_audiences can report audience_size and targetable_size as bounded ranges, and matched_count may be absent: never read absence as zero. Signal listings can carry age_determination_bases (verified, declared, inferred). Experimental, survey only: signal pricing groups, provider delivery methods, and signal readiness (signal_status). Not graded.$notes$::text);

SELECT _c33_append_key_concept('S6', 'AdCP 3.3 agent identity and bounds',
  $notes$3.3 identifies a signing agent by its origin. The experimental Web Bot Auth profile verifies a request against the key directory at the signer's origin, with no capabilities call and no seller-issued credential; the RFC 9421 brand.json signing profile is deprecated in 3.3 and keeps working through 3.x. One agent-resolution rule now covers request signing, webhook signing, governance JWS iss, designated-task response signing, and rights attestations, so some signatures that verified under 3.2 now fail. The A2A required_for hardening clauses are MUST, and verifiers declare enforcement in request_signing.operation_sources. Clients should bound every response they read (4 MiB by default, enforced while streaming, with JSON depth and node limits), and webhook receivers should bound the body before verifying a signature and answer 413. Teach these as current rules; the S6 labs and criteria stay on the surfaces the sandbox exercises.$notes$::text);

SELECT _c33_append_key_concept('S7', 'AdCP 3.3 identity rules',
  $notes$In 3.3 an agent's identity is its origin. An origin-only authorized_agents[].url in adagents.json authorizes the agent at that origin whatever its path, while an entry with a path matches only that URL. When several entries match one agent, its scope is their union, and a signing_keys pin holds only if every matching entry that authorizes the message pins keys. Property domain and subdomain identifiers are lowercase ASCII hostnames. Verifiers accept brand.json up to 2 MiB. brand.json gains a brand-wide prohibited_terms list, and an operator's trust.json (experimental) lists its agents by origin. Mention these where they come up; they are not graded.$notes$::text);

DROP FUNCTION _c33_replace_criterion_passage(text, text, text, text, text);
DROP FUNCTION _c33_replace_criterion_text(text, text, text, text);
DROP FUNCTION _c33_replace_concept_passage(text, text, text, text);
DROP FUNCTION _c33_set_key_concept(text, text, text, text);
DROP FUNCTION _c33_append_key_concept(text, text, text);
DROP FUNCTION _c33_replace_sandbox_action(text, text, text, text, text);
