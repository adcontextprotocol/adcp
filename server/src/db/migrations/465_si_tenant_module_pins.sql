-- Pin A3, C3, and S5 to the new `si` training-agent tenant, which was
-- explicitly left NULL in migration 464 because no `si_*`-serving tenant
-- existed at the time. This migration follows once the tenant ships.
--
-- Additional curriculum fixes bundled here (education-expert review of #3940):
--
-- 1. C3 c3_ex2 phantom tool: `connect_to_si_agent` is an Addie-specific host
--    tool (server/src/addie/mcp/si-host-tools.ts), not a protocol-defined
--    AdCP task. The training agent has never served it. Replace with
--    `si_initiate_session` — the correct entry point for the SI lifecycle.
--
-- 2. S5 criterion IDs: The s5_ex1 success_criteria were defined as plain text
--    strings (migration 270 seed, overwritten verbatim by migrations 303/298).
--    The _append_criterion helper (migration 407) adds stable IDs the
--    recertification engine can target when SI experimental surfaces change.
--    Adds s5_ex1_sc_session_lifecycle and s5_ex1_sc_offering_integration —
--    the two criteria covering the graded competencies at highest assessment
--    weight in S5's protocol_mastery dimension.

-- ── 1. Pin tenant_ids ───────────────────────────────────────────────────────

-- A3: add si to the landscape tour (the tour already lists the other six
-- tenants from migration 464; si is the missing stop).
UPDATE certification_modules
  SET tenant_ids = ARRAY['sales', 'signals', 'governance', 'creative', 'brand', 'si']
  WHERE id = 'A3' AND tenant_ids IS NULL;

-- C3: creative + sponsored intelligence — si is the primary SI surface;
-- creative and brand remain for sync_creatives / creative_approval exercises.
-- Drops creative-builder (per #3930 review: creative-builder is S2-specific).
UPDATE certification_modules
  SET tenant_ids = ARRAY['creative', 'brand', 'si']
  WHERE id = 'C3' AND tenant_ids IS NULL;

-- S5: specialist deep-dive — si is the sole primary tenant for the full
-- si_* session lifecycle capstone.
UPDATE certification_modules
  SET tenant_ids = ARRAY['si']
  WHERE id = 'S5' AND tenant_ids IS NULL;

-- ── 2. Fix C3 c3_ex2 phantom tool ──────────────────────────────────────────
--
-- Replace `connect_to_si_agent` in sandbox_actions with `si_initiate_session`.
-- The exercise intent (connecting to a brand SI agent) is preserved; only the
-- tool name and guidance text change to match the actual protocol tool.
-- Safe to replay: the CASE condition matches only the phantom name.

UPDATE certification_modules
  SET exercise_definitions = (
    SELECT jsonb_agg(
      CASE
        WHEN ex->>'id' = 'c3_ex2'
        THEN jsonb_set(
          ex,
          '{sandbox_actions}',
          (
            SELECT jsonb_agg(
              CASE
                WHEN act->>'tool' = 'connect_to_si_agent'
                THEN jsonb_build_object(
                  'tool', 'si_initiate_session',
                  'guidance', 'Initiate a session with the training SI brand agent. Provide an intent describing what the user is looking for. Examine the session_id, negotiated_capabilities, and the brand''s opening message — the host-side entry point to the SI Chat Protocol.'
                )
                ELSE act
              END
            )
            FROM jsonb_array_elements(ex->'sandbox_actions') act
          )
        )
        ELSE ex
      END
    )
    FROM jsonb_array_elements(exercise_definitions) ex
  )
  WHERE id = 'C3'
    AND exercise_definitions::text LIKE '%connect_to_si_agent%';

-- ── 3. S5 stable criterion IDs ──────────────────────────────────────────────
--
-- Re-declare the _append_criterion helper (CREATE OR REPLACE — idempotent)
-- then stamp two semantic IDs onto s5_ex1. These IDs let the recertification
-- engine identify credential holders who need re-assessment when the SI
-- experimental surface changes.

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

SELECT _append_criterion(
  'S5',
  's5_ex1',
  's5_ex1_sc_session_lifecycle',
  'Demonstrates the full SI session lifecycle: calls si_get_offering, si_initiate_session, si_send_message (at least one turn), and si_terminate_session in correct protocol order.'
);

SELECT _append_criterion(
  'S5',
  's5_ex1',
  's5_ex1_sc_offering_integration',
  'Uses si_get_offering before session initiation and passes the returned offering_token to si_initiate_session, demonstrating the session-continuity handoff.'
);
