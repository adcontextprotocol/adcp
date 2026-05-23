-- Fix B1 certification: sync_catalogs is buyer-to-seller (issue #4964)
--
-- Migration 274 introduced B1 teaching notes that wrote from the seller's
-- reception perspective ("Accept feeds from Google Merchant Center...") without
-- stating the caller role. Sage read this as "seller calls sync_catalogs" and
-- taught accordingly. The spec is unambiguous (docs/creative/catalogs.mdx:46):
-- sync_catalogs is buyer-to-seller.
--
-- Changes:
--   lesson_plan.objectives[1]          — reframe from "Use sync_catalogs" to
--                                        "Understand how buyers use sync_catalogs"
--   lesson_plan.key_concepts[1]        — add explicit buyer-to-seller direction
--   lesson_plan.demo_scenarios[1]      — reframe expected_outcome from seller POV
--   exercise_definitions[0]            — fix sandbox_actions[1] guidance + b1_ex1_sc1
--   assessment_criteria.practical_knowledge — align description and scoring to
--                                             seller-receives, not seller-calls

-- Re-declare the helper dropped at the end of 407_curriculum_3_0_criterion_ids.sql
-- and 477_broadcast_delivery_criteria.sql. This function is not a persistent
-- fixture — each migration that needs it must define and drop it locally.
CREATE OR REPLACE FUNCTION _append_criterion(
  p_module_id text,
  p_exercise_id text,
  p_criterion_id text,
  p_text text
) RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  criteria jsonb;
  already_present boolean;
  exercise_matched boolean := false;
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
      exercise_matched := true;
      criteria := COALESCE(ex->'success_criteria', '[]'::jsonb);

      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(criteria) c
        WHERE c->>'id' = p_criterion_id
      ) INTO already_present;

      IF NOT already_present THEN
        criteria := criteria || jsonb_build_array(
          jsonb_build_object('id', p_criterion_id, 'text', p_text)
        );
        ex := jsonb_set(ex, '{success_criteria}', criteria);
      END IF;
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT exercise_matched THEN
    RAISE EXCEPTION 'Exercise % not found in module %', p_exercise_id, p_module_id;
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  lp       jsonb;
  ed       jsonb;
  ac       jsonb;
  sc_row   jsonb;
  dim_row  jsonb;
  new_criteria jsonb;
  new_dims     jsonb;
BEGIN
  SELECT lesson_plan, exercise_definitions, assessment_criteria
  INTO lp, ed, ac
  FROM certification_modules WHERE id = 'B1';

  IF lp IS NULL THEN
    RAISE EXCEPTION 'B1 module not found — cannot apply sync_catalogs direction fix';
  END IF;

  -- 1. Objective: "Use sync_catalogs..." → seller-receives framing
  IF lp->'objectives'->>1 = 'Use sync_catalogs to integrate product data from feeds' THEN
    lp := jsonb_set(lp, '{objectives,1}',
      '"Understand how buyers use sync_catalogs to push catalog feeds to your seller account, and how to configure accepted catalog types and the item-level approval workflow"'::jsonb
    );
  END IF;

  -- 2. Catalog integration teaching note: add explicit buyer-to-seller direction
  IF lp->'key_concepts'->1->>'topic' = 'Catalog integration' THEN
    lp := jsonb_set(lp, '{key_concepts,1,teaching_notes}',
      '"sync_catalogs is buyer-to-seller: the buyer calls sync_catalogs on your seller agent to push product feeds (13 catalog types). Your role as a seller is to declare which catalog types you accept via get_adcp_capabilities and implement the item-level approval workflow. Feed sources (Google Merchant Center, Shopify, etc.) are the buyer''s concern — you see a normalized catalog object after feed_field_mappings are applied."'::jsonb
    );
  END IF;

  -- 3. Demo scenario expected_outcome: reframe from buyer-doing to seller-observing
  IF lp->'demo_scenarios'->1->>'description' = 'Sync product data' THEN
    lp := jsonb_set(lp, '{demo_scenarios,1,expected_outcome}',
      '"See how a buyer calls sync_catalogs on @cptestagent and how the seller returns per-item approval status — this is what your seller agent must produce"'::jsonb
    );
  END IF;

  -- 4. Exercise sandbox action: sync_catalogs at index 1 — reframe to seller-observes
  IF ed->0->'sandbox_actions'->1->>'tool' = 'sync_catalogs' THEN
    ed := jsonb_set(ed, '{0,sandbox_actions,1,guidance}',
      '"Call sync_catalogs on @cptestagent as if you were a buyer pushing product data. Observe the per-item approval response your seller agent must implement."'::jsonb
    );
  END IF;

  -- 5. Success criterion b1_ex1_sc1: update text to match corrected learning objective
  new_criteria := '[]'::jsonb;
  FOR sc_row IN SELECT * FROM jsonb_array_elements(ed->0->'success_criteria')
  LOOP
    IF sc_row->>'id' = 'b1_ex1_sc1' THEN
      sc_row := jsonb_set(sc_row, '{text}',
        '"Can explain that sync_catalogs is buyer-to-seller, describe the seller''s role (declare accepted catalog types via get_adcp_capabilities, implement item-level approval), and interpret the per-item approval responses a seller must return"'::jsonb
      );
    END IF;
    new_criteria := new_criteria || jsonb_build_array(sc_row);
  END LOOP;
  ed := jsonb_set(ed, '{0,success_criteria}', new_criteria);

  -- 6. Assessment practical_knowledge dimension: align to seller-receives framing
  new_dims := '[]'::jsonb;
  FOR dim_row IN SELECT * FROM jsonb_array_elements(ac->'dimensions')
  LOOP
    IF dim_row->>'name' = 'practical_knowledge' THEN
      dim_row := jsonb_set(dim_row, '{description}',
        '"Understands the buyer-to-seller sync_catalogs flow and can configure seller-side catalog acceptance"'::jsonb
      );
      dim_row := jsonb_set(dim_row, '{scoring_guide,high}',
        '"Can describe buyer-to-seller direction, accepted catalog types via get_adcp_capabilities, and item-level approval flow"'::jsonb
      );
      dim_row := jsonb_set(dim_row, '{scoring_guide,medium}',
        '"Understands buyer-to-seller direction but uncertain on catalog types or approval workflow details"'::jsonb
      );
      dim_row := jsonb_set(dim_row, '{scoring_guide,low}',
        '"Cannot describe the buyer-to-seller direction or the seller''s role in sync_catalogs"'::jsonb
      );
    END IF;
    new_dims := new_dims || jsonb_build_array(dim_row);
  END LOOP;
  ac := jsonb_set(ac, '{dimensions}', new_dims);

  UPDATE certification_modules
  SET
    lesson_plan          = lp,
    exercise_definitions = ed,
    assessment_criteria  = ac
  WHERE id = 'B1';
END;
$$;

-- Append a stable criterion for recertification targeting: prior B1 holders who
-- passed under the inverted direction can be flagged by this criterion ID.
SELECT _append_criterion(
  'B1', 'b1_ex1', 'b1_ex1_sc_catalog_direction',
  'Correctly states that sync_catalogs is buyer-to-seller: the buyer calls sync_catalogs on the seller agent; the seller''s role is to declare accepted catalog types and implement the approval workflow.'
);

DROP FUNCTION _append_criterion(text, text, text, text);
