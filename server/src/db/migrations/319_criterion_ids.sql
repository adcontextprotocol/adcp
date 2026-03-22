-- Add stable IDs to exercise success_criteria for reliable demonstration tracking.
-- Pattern: {exercise_id}_sc{index} (e.g., a1_ex1_sc0, b4_specify_sc1)
--
-- Each success_criteria entry changes from a plain string to an object:
--   { "id": "a1_ex1_sc0", "text": "Successfully queries @cptestagent..." }
--
-- This replaces exact-string matching with ID matching, eliminating silent
-- failures when criteria wording changes.

-- Also rewrites A3 criteria from recall-based to behavioral (education expert review).

-- Helper function for this migration only
CREATE OR REPLACE FUNCTION _add_criterion_ids(exercise_defs jsonb) RETURNS jsonb AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  ex jsonb;
  ex_id text;
  criteria jsonb;
  new_criteria jsonb;
  sc text;
  sc_idx int;
BEGIN
  FOR ex IN SELECT * FROM jsonb_array_elements(exercise_defs)
  LOOP
    ex_id := ex->>'id';
    criteria := ex->'success_criteria';
    new_criteria := '[]'::jsonb;
    sc_idx := 0;
    FOR sc IN SELECT * FROM jsonb_array_elements_text(criteria)
    LOOP
      new_criteria := new_criteria || jsonb_build_object(
        'id', ex_id || '_sc' || sc_idx,
        'text', sc
      );
      sc_idx := sc_idx + 1;
    END LOOP;
    ex := jsonb_set(ex, '{success_criteria}', new_criteria);
    result := result || jsonb_build_array(ex);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Apply to all modules
UPDATE certification_modules
SET exercise_definitions = _add_criterion_ids(exercise_definitions)
WHERE exercise_definitions IS NOT NULL
  AND exercise_definitions != 'null'::jsonb
  AND jsonb_array_length(exercise_definitions) > 0;

-- Drop helper
DROP FUNCTION _add_criterion_ids(jsonb);

-- Rewrite A3 criteria from recall-based to behavioral
UPDATE certification_modules
SET exercise_definitions = jsonb_set(
  exercise_definitions,
  '{0,success_criteria}',
  '[
    {"id": "a3_ex1_sc0", "text": "Given a scenario, can identify which protocol domain handles it and explain why"},
    {"id": "a3_ex1_sc1", "text": "Can explain what brand.json enables for a buyer agent encountering a new brand"},
    {"id": "a3_ex1_sc2", "text": "Can describe what happens when a buyer agent reads adagents.json from a publisher domain"},
    {"id": "a3_ex1_sc3", "text": "Can explain the difference between a creative format and a creative manifest with a concrete example"},
    {"id": "a3_ex1_sc4", "text": "Can describe a scenario where Sponsored Intelligence fits better than a traditional display ad"}
  ]'::jsonb
)
WHERE id = 'A3';

-- Add demonstration_evidence: maps criterion ID to brief rationale for accreditation audit trail.
-- E.g., {"a1_ex1_sc0": "Learner queried @cptestagent and correctly interpreted pricing fields (turn 5)"}
ALTER TABLE teaching_checkpoints
  ADD COLUMN IF NOT EXISTS demonstration_evidence JSONB DEFAULT '{}';

-- Clear any existing demonstrations_verified since format is changing from strings to IDs.
-- Only affects in-progress learners who saved checkpoints with the old string format.
-- They will need to re-verify with the new ID-based system.
UPDATE teaching_checkpoints
SET demonstrations_verified = '{}'
WHERE demonstrations_verified != '{}';
