-- Teach and assess the experimental reporting.core lifecycle on both sides of
-- the exchange. The public sales sandbox exposes a deterministic lifecycle
-- probe so learners can observe obligation-before-report behavior without
-- waiting for wall-clock period boundaries.

CREATE TABLE IF NOT EXISTS training_reporting_ledgers (
  principal_scope text NOT NULL,
  account_id text NOT NULL,
  ledger jsonb NOT NULL,
  account_scope text,
  account_ref jsonb,
  account_state jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_scope, account_id),
  CONSTRAINT training_reporting_ledgers_principal_scope_unique
    UNIQUE (principal_scope, account_scope),
  CONSTRAINT training_reporting_ledgers_account_ref_object
    CHECK (account_ref IS NULL OR jsonb_typeof(account_ref) = 'object'),
  CONSTRAINT training_reporting_ledgers_account_state_object
    CHECK (account_state IS NULL OR jsonb_typeof(account_state) = 'object')
);

COMMENT ON TABLE training_reporting_ledgers IS
  'Durable caller/account settings binding, reporting configuration, obligation-denominator, and immutable revision ledger for the public training seller.';

UPDATE certification_modules SET duration_minutes = 35 WHERE id = 'B3';
UPDATE certification_modules SET duration_minutes = 60 WHERE id = 'S1';

CREATE OR REPLACE FUNCTION _append_reporting_key_concept(
  p_module_id text,
  p_topic text,
  p_teaching_notes text
) RETURNS void AS $$
BEGIN
  UPDATE certification_modules
  SET lesson_plan = jsonb_set(
    lesson_plan,
    '{key_concepts}',
    COALESCE(lesson_plan->'key_concepts', '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('topic', p_topic, 'teaching_notes', p_teaching_notes)
    )
  )
  WHERE id = p_module_id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(lesson_plan->'key_concepts', '[]'::jsonb)) concept
      WHERE concept->>'topic' = p_topic
    );

  IF NOT EXISTS (SELECT 1 FROM certification_modules WHERE id = p_module_id) THEN
    RAISE EXCEPTION 'Module % not found', p_module_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT _append_reporting_key_concept(
  'B3',
  'Reliable reporting obligations',
  'Teach the seller lifecycle separately from report production. The applicable reporting configuration generation establishes the schedule; media-buy acceptance alone does not. At each eligible period.end, freeze the exact media-buy denominator and commit the obligation independently of source availability and before committing a revision; expose it in the first ledger snapshot strictly after period.end, never at or before the boundary. expected_at equals period.end plus delivery_sla. Use reporting_core_lifecycle_probe early: prepare and read the waiting obligation, advance it to delayed, then publish and read a zero-row revision. reporting.delivery_ready means a verified managed materialization, reporting.status_changed is an optional health invalidation, and get_reporting_status remains authoritative.'
);

SELECT _append_reporting_key_concept(
  'S1',
  'Buyer-side reporting reconciliation',
  'Teach buyers to retain accepted reporting configuration generations, derive expected half-open periods independently, and require one matching obligation for every expected period. Use reporting_core_lifecycle_probe plus get_reporting_status as the live lab: inspect one obligation before its first revision, advance through the SLA, and distinguish a zero-row revision from a missing revision. Optional doorbells remain wake-ups, not authoritative repair.'
);

DROP FUNCTION _append_reporting_key_concept(text, text, text);

CREATE OR REPLACE FUNCTION _append_reporting_sandbox_action(
  p_module_id text,
  p_exercise_id text,
  p_tool text,
  p_guidance text
) RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  actions jsonb;
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
      actions := COALESCE(ex->'sandbox_actions', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(actions) action
        WHERE action->>'tool' = p_tool AND action->>'guidance' = p_guidance
      ) THEN
        actions := actions || jsonb_build_array(
          jsonb_build_object('tool', p_tool, 'guidance', p_guidance)
        );
        ex := jsonb_set(ex, '{sandbox_actions}', actions);
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

SELECT _append_reporting_sandbox_action(
  'B3',
  'b3_ex1',
  'comply_test_controller',
  'Bounded 10–15 minute reporting reliability lab: prepare the Core fixture and save its resolved configuration, period, obligation ID, expected_at, and recovery deadline; read the same obligation, advance_time to delayed, and publish_zero_row. Reset with prepare, call omit_obligation, and submit a four-row observation table for waiting, delayed, zero-row, and missing-obligation states.'
);

SELECT _append_reporting_sandbox_action(
  'B3',
  'b3_ex1',
  'get_reporting_status',
  'As a seller implementer, compare the periods view before and after each lifecycle operation. Explain why the obligation exists before a revision, why health changes only after expected_at, and why row_count zero proves an empty report rather than a missing one. Flag as errors any clock started at buy acceptance or notification treated as ledger evidence.'
);

SELECT _append_reporting_sandbox_action(
  'S1',
  's1_ex1',
  'comply_test_controller',
  'Complete the bounded 10–15 minute reporting reliability lab: prepare the fixture, capture its resolved configuration, period, obligation ID, expected_at, and recovery deadline, and advance the same obligation through delayed before publishing an explicit zero-row revision. Reset with prepare, then call omit_obligation for the supplied negative fixture.'
);

SELECT _append_reporting_sandbox_action(
  'S1',
  's1_ex1',
  'get_reporting_status',
  'As a buyer, derive expected periods from the returned configuration, exhaust the periods view, and submit an expected-versus-observed table covering waiting, delayed, zero-row, and the deliberately omitted obligation. Treat seller-ledger-as-denominator logic, buy-acceptance clocks, and doorbell-as-evidence answers as errors.'
);

DROP FUNCTION _append_reporting_sandbox_action(text, text, text, text);

CREATE OR REPLACE FUNCTION _append_reporting_criterion(
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
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(criteria) criterion
        WHERE criterion->>'id' = p_criterion_id
      ) THEN
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

SELECT _append_reporting_criterion(
  'B3',
  'b3_ex1',
  'b3_ex1_sc_reporting_obligation_lifecycle',
  'From the supplied hourly reporting configuration and ledger fixture, places obligation commitment at period.end independently of source availability and before revision commit, exposes it in the first ledger snapshot strictly after the boundary, calculates expected_at from delivery_sla, distinguishes zero rows from missing reporting, and assigns get_reporting_status and each optional doorbell its correct role.'
);

SELECT _append_reporting_criterion(
  'S1',
  's1_ex1',
  's1_ex1_sc_reliable_reporting_reconciliation',
  'From the supplied configuration and positive and omitted-obligation fixtures, derives the buyer-side expected-period denominator, identifies the deliberately missing obligation in an expected-versus-observed table, distinguishes period-end obligation availability from expected-at lateness, and uses get_reporting_status rather than a doorbell as authoritative evidence.'
);

DROP FUNCTION _append_reporting_criterion(text, text, text, text);
