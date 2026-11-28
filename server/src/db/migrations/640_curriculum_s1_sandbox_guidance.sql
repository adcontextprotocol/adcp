-- Point S1 learners at the sandbox fixtures and offers each demonstration needs,
-- and retire S1's 3.0 "refinement protocol" wording.
--
-- The S1 sandbox fixes (adcontextprotocol/adcp#9216, closes #9087) seed a
-- broadcast buy, accept keyword buys on the search and retail-media offers,
-- and explain the sandbox-account refusal on comply_test_controller. The
-- learner and Sage still had no pointer to any of them:
--   1. s1_ex1_sc_broadcast_delivery_windows names no broadcast buy;
--   2. the reporting lab never says controller calls need sandbox: true;
--   3. the keyword exercises don't say only search and retail-media offers
--      declare keyword_targets, so a display product's correct
--      UNSUPPORTED_FEATURE refusal reads as a sandbox bug.
-- Item 4: s1_ex1_sc1 and the S1 "Refinement protocol" concept describe the
-- 3.0 get_products refine[] flow. From 3.2 the evidence is refine_proposals
-- before accept_proposal, or update_media_buy after the buy.
--
-- Items 1-3 name fixtures that exist only once #9216 is deployed to the hosted
-- training agent; deploy this migration with or after it. Criterion IDs are
-- unchanged: teaching checkpoints store them, and completion requires every
-- current ID.

CREATE OR REPLACE FUNCTION _s1_append_action_guidance(
  p_module_id text,
  p_exercise_id text,
  p_tool text,
  p_addition text
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
        IF action->>'tool' = p_tool THEN
          matches := matches + 1;
          IF position(p_addition IN COALESCE(action->>'guidance', '')) = 0 THEN
            action := jsonb_set(action, '{guidance}',
              to_jsonb(btrim(COALESCE(action->>'guidance', '') || ' ' || p_addition)));
          END IF;
        END IF;
        actions := actions || jsonb_build_array(action);
      END LOOP;
      ex := jsonb_set(ex, '{sandbox_actions}', actions);
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one % sandbox action in exercise % of module %, found %',
      p_tool, p_exercise_id, p_module_id, matches;
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _s1_insert_action_after(
  p_module_id text,
  p_exercise_id text,
  p_after_tool text,
  p_tool text,
  p_guidance text
) RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  actions jsonb;
  action jsonb;
  anchored boolean := false;
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
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(ex->'sandbox_actions', '[]'::jsonb)) existing
        WHERE existing->>'tool' = p_tool AND existing->>'guidance' = p_guidance
      ) THEN
        RETURN;
      END IF;
      actions := '[]'::jsonb;
      FOR action IN SELECT * FROM jsonb_array_elements(COALESCE(ex->'sandbox_actions', '[]'::jsonb))
      LOOP
        actions := actions || jsonb_build_array(action);
        IF NOT anchored AND action->>'tool' = p_after_tool THEN
          anchored := true;
          actions := actions || jsonb_build_array(
            jsonb_build_object('tool', p_tool, 'guidance', p_guidance)
          );
        END IF;
      END LOOP;
      ex := jsonb_set(ex, '{sandbox_actions}', actions);
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT anchored THEN
    RAISE EXCEPTION 'No % sandbox action in exercise % of module %', p_after_tool, p_exercise_id, p_module_id;
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _s1_replace_criterion_text(
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

-- 1. Name the broadcast fixture.
SELECT _s1_insert_action_after('S1', 's1_ex1', 'get_media_buy_delivery', 'get_media_buy_delivery',
  'For the broadcast measurement-window criterion, call get_media_buys with status_filter ["completed"] on the sandbox account, then get_media_buy_delivery on the broadcast buy seed_mb_broadcast_q4. Its delivery reports a provisional c3 window (is_final: false) against a C7 billing guarantee, and dated reads are prorated.');

-- 2. The reporting lab must reference a sandbox account.
SELECT _s1_append_action_guidance('S1', 's1_ex1', 'comply_test_controller',
  'Every controller call references the account with sandbox: true, for example {"account_id":"<id>","sandbox":true}; a bare account_id from sync_accounts is refused.');

-- 3. Keyword targeting needs an offer that declares it.
SELECT _s1_append_action_guidance('S1', 's1_ex1', 'create_media_buy',
  'For the keyword part, use a search or retail-media product whose overlay_support declares keyword_targets (Beacon Search or ShopGrid in the sandbox catalogue). Display, video, and audio products refuse keyword_targets with UNSUPPORTED_FEATURE, which is the correct behaviour.');

-- 4. Refinement is refine_proposals before the buy, update_media_buy after it.
SELECT _s1_replace_criterion_text('S1', 's1_ex1', 's1_ex1_sc1',
  'Negotiates before the buy with refine_proposals (revise, then finalize; extend_hold only on a seller that advertises it) and buys the finalized proposal with accept_proposal, or changes a live buy with update_media_buy, and explains which of the two applies when.');

DO $$
DECLARE
  plan jsonb;
  concepts jsonb := '[]'::jsonb;
  concept jsonb;
  concept_matched boolean := false;
BEGIN
  SELECT lesson_plan INTO plan
  FROM certification_modules
  WHERE id = 'S1';

  IF plan IS NULL OR jsonb_typeof(plan->'key_concepts') <> 'array' THEN
    RAISE EXCEPTION 'Module S1 not found or has no key_concepts array';
  END IF;

  FOR concept IN SELECT * FROM jsonb_array_elements(plan->'key_concepts')
  LOOP
    IF concept->>'topic' IN ('Refinement protocol', 'Refining proposals and changing buys') THEN
      concept_matched := true;
      concept := jsonb_build_object(
        'topic', 'Refining proposals and changing buys',
        'teaching_notes', $notes$Before the buy, refine_proposals is the negotiation: revise a proposal (budget, products, flight, targeting), then finalize it, which commits priced terms and may place a hold. A seller that advertises media_buy.hold_extension (experimental in 3.3) also accepts extend_hold, which lengthens a committed hold without finalizing again. accept_proposal buys the finalized proposal. After the buy, update_media_buy changes it; on the compact lifecycle, control_media_buy handles operational changes inside the agreed envelope. The refine[] array and refinement_applied on the deprecated get_products task are the 3.0 form of the same negotiation: recognise them, but teach refine_proposals.$notes$::text
      );
    END IF;
    concepts := concepts || jsonb_build_array(concept);
  END LOOP;

  IF NOT concept_matched THEN
    RAISE EXCEPTION 'S1 key concept "Refinement protocol" not found';
  END IF;

  plan := jsonb_set(plan, '{key_concepts}', concepts);

  IF plan->'objectives' @> '["Use refinement protocol for campaign modifications"]'::jsonb THEN
    plan := jsonb_set(plan, '{objectives}', (
      SELECT jsonb_agg(
        CASE WHEN objective = 'Use refinement protocol for campaign modifications'
          THEN to_jsonb('Negotiate with refine_proposals before the buy, and change live buys with update_media_buy'::text)
          ELSE to_jsonb(objective)
        END ORDER BY ordinality)
      FROM jsonb_array_elements_text(plan->'objectives') WITH ORDINALITY AS o(objective, ordinality)
    ));
  END IF;

  UPDATE certification_modules
  SET lesson_plan = plan
  WHERE id = 'S1';
END;
$$;

DROP FUNCTION _s1_append_action_guidance(text, text, text, text);
DROP FUNCTION _s1_insert_action_after(text, text, text, text, text);
DROP FUNCTION _s1_replace_criterion_text(text, text, text, text);
