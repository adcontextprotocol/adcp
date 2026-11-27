-- Correct the A2 and B1 capability-declaration success criteria (issue #8925).
--
-- Migration 407 told Sage that AdCP capabilities are declared "by object
-- presence, not booleans" and that unsupported features are always omitted.
-- That only holds for the optional feature objects that replaced the boolean
-- gates removed in AdCP 3.0 (media_buy.audience_targeting, for example). The
-- get_adcp_capabilities schema also carries explicit booleans and supported
-- flags, and requires adcp.idempotency even when the answer is no
-- ({"supported": false}). Sage marked learners who described the schema
-- correctly as UNMET, which blocked A2 completion.
--
-- Criterion IDs stay unchanged: teaching checkpoints store them in
-- demonstrations_verified and demonstration_evidence, and completion requires
-- every current ID, so a rename would discard verification already recorded
-- and orphan the audit trail.

CREATE OR REPLACE FUNCTION _replace_criterion_text(
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

SELECT _replace_criterion_text('A2', 'a2_ex1', 'a2_ex1_sc_object_presence_principle',
  'Explains that each get_adcp_capabilities field follows its own schema contract: some optional feature objects signal support by being present (e.g. media_buy.audience_targeting), while other blocks carry booleans or a supported flag that can be present with a false value (e.g. adcp.idempotency declared as {"supported": false}). Naming these exact fields is not required; any accurate example of each pattern meets this criterion.');

SELECT _replace_criterion_text('B1', 'b1_ex1', 'b1_ex1_sc_object_presence_capabilities',
  'Declares each capability in get_adcp_capabilities the way its schema defines it: includes optional feature objects whose presence is the signal (such as media_buy.audience_targeting or media_buy.content_standards) only when the feature is supported, sets explicit booleans and supported flags to accurate values, and always emits required blocks even when the answer is no: adcp.idempotency is declared as {"supported": false} when the agent does not deduplicate replays, never omitted.');

DROP FUNCTION _replace_criterion_text(text, text, text, text);

-- A2 grades capability reading but its lesson plan never taught it, so Sage
-- had only the criterion text to teach from.
CREATE OR REPLACE FUNCTION _append_key_concept(
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

SELECT _append_key_concept('A2', 'Reading capabilities',
  'get_adcp_capabilities tells a buyer what a seller supports, and each field follows its own schema contract. Some optional feature objects signal support by being present (media_buy.audience_targeting, media_buy.content_standards); other blocks carry booleans or a supported flag that can be present with a false value. adcp.idempotency is required in every response and reads {"supported": false} when the seller does not deduplicate replays, so the idempotency_key on create_media_buy only makes a retry safe when the seller declares supported: true. Teach one example of each pattern. Do not teach that capabilities are never booleans or that unsupported features are always omitted, and do not require learners to name exact fields.');

DROP FUNCTION _append_key_concept(text, text, text);
