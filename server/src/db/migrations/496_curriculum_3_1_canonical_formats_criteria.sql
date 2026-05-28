-- Add SuccessCriterion IDs for AdCP 3.1 canonical-format demonstrations in S2.
--
-- These criteria are intentionally limited to the concepts exercised by the
-- S2 canonical-formats authoring lab. Third-party creative-agent flow and
-- preview-status recertification criteria should land only after those tasks
-- are explicitly assessable in the module.

-- S2 remains creative-primary. The sales tenant is also in scope because the
-- canonical-format lab asks creative learners to read product format_options[]
-- with get_products before building or syncing creative assets.
UPDATE certification_modules
SET tenant_ids = ARRAY['creative', 'creative-builder', 'sales']
WHERE id = 'S2'
  AND tenant_ids IS DISTINCT FROM ARRAY['creative', 'creative-builder', 'sales'];

UPDATE certification_modules
SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  COALESCE(lesson_plan->'key_concepts', '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'topic', 'Canonical formats',
      'teaching_notes', 'AdCP 3.1 products may publish format_options[] that narrow shared canonical formats such as image, video_hosted, or native_in_feed. Teach learners to select format_kind by creative shape, validate against the canonical first and the product narrowing second, select format_option_id when a product publishes one, and distinguish buyer_uploaded, agent_synthesized, seller_pre_rendered_from_brief, seller_human_designed, and publisher_host_recorded asset_source values.'
    )
  )
)
WHERE id = 'S2'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(lesson_plan->'key_concepts', '[]'::jsonb)) concept
    WHERE concept->>'topic' = 'Canonical formats'
  );

CREATE OR REPLACE FUNCTION _update_s2_canonical_exercise()
RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  actions jsonb;
  already_present boolean;
  exercise_matched boolean := false;
BEGIN
  SELECT exercise_definitions INTO defs
  FROM certification_modules
  WHERE id = 'S2';

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module S2 not found or has no exercise_definitions array';
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = 's2_ex1' THEN
      exercise_matched := true;
      -- S2 exercise 1 prose is migration-owned for the 3.1 canonical-format
      -- lab; re-runs intentionally restore this title and description.
      ex := jsonb_set(ex, '{title}', to_jsonb('Creative production and canonical-format authoring'::text));
      ex := jsonb_set(ex, '{description}', to_jsonb('Build, preview, and sync creatives while also authoring against 3.1 product format_options[] declarations.'::text));

      actions := COALESCE(ex->'sandbox_actions', '[]'::jsonb);
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(actions) action
        WHERE action->>'tool' = 'get_products'
          AND action->>'guidance' ILIKE '%format_options%'
      ) INTO already_present;

      IF NOT already_present THEN
        actions := actions || jsonb_build_array(
          jsonb_build_object(
            'tool', 'get_products',
            'guidance', 'Read 3.1 product format_options[] from a sales-agent product and identify format_kind, format_option_id when present, asset_source, and the canonical-first/product-second validation order before building or syncing a creative.'
          )
        );
        ex := jsonb_set(ex, '{sandbox_actions}', actions);
      END IF;
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT exercise_matched THEN
    RAISE EXCEPTION 'Exercise s2_ex1 not found in module S2';
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = 'S2';
END;
$$ LANGUAGE plpgsql;

SELECT _update_s2_canonical_exercise();

DROP FUNCTION _update_s2_canonical_exercise();

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

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_format_kind_selection',
  'Selects the correct format_kind for a product and creative manifest, and distinguishes creative shape from delivery channel, targeting, or measurement context.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_format_options_cardinality',
  'Reads product format_options[] and explains single-option, multi-option, and multi-size fan-out declarations, including when a buyer should select a format_option_id.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_option_vs_capability_id',
  'Distinguishes product-level format_option_id from creative-agent capability_id and avoids substituting one namespace for the other in media-buy products or creative manifests.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_source_taxonomy',
  'Chooses the correct asset_source model across buyer_uploaded, agent_synthesized, seller_pre_rendered_from_brief, seller_human_designed, and publisher_host_recorded workflows, and maps that choice to the manifest assets or seller/publisher-supplied inputs required.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_validation_order',
  'Explains why sellers validate against the shared canonical shape before applying product-specific narrowing, and why creative-agent capabilities only narrow what the agent can produce.');

DROP FUNCTION _append_criterion(text, text, text, text);
