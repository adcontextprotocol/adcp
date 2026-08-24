-- Add auditable AdCP 3.2 specialist criteria and the teaching actions that
-- produce evidence for them. Prior-holder targeting remains gated by the
-- GA/effective-date policy in docs/learning/policies/recertification.mdx.

CREATE OR REPLACE FUNCTION _append_3_2_key_concept(
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

  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM certification_modules WHERE id = p_module_id) THEN
    RAISE EXCEPTION 'Module % not found', p_module_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT _append_3_2_key_concept('S1', 'AdCP 3.2 compact planning and buying',
  'Use advertised lifecycle_tools to choose list_products, request_proposals, refine_proposals, buy_products, accept_proposal, and control_media_buy. Separate offer filters, current targeting, and future targeting support; require readback evidence for effective targeting. Use availability_horizon and outcome_target only when advertised, and distinguish planning guidance from a finalized commercial obligation.');

SELECT _append_3_2_key_concept('S2', 'AdCP 3.2 creative interoperability',
  'Validate logical dimensions separately from intrinsic pixel density and distinguish accepted pixel_ratios from required_pixel_ratios rendition coverage. Apply the advertised VAST validation level, format-required accessibility detail, and provenance requirements; a declaration is not independent verification.');

SELECT _append_3_2_key_concept('S6', 'AdCP 3.2 request and webhook integrity',
  'On 3.2 request-signing endpoints, every signed body covers content-digest and request Signature/Content-Digest sf-binary values use RFC 8941 padded standard Base64 without a legacy-parser fallback. For webhook delivery, operation_id is buyer correlation while the payload idempotency_key is sender-generated dedup identity and remains stable across exact retries.');

DROP FUNCTION _append_3_2_key_concept(text, text, text);

CREATE OR REPLACE FUNCTION _instrument_3_2_exercise(
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

SELECT _instrument_3_2_exercise('S1', 's1_ex1', 'request_proposals',
  'On the exact 3.2 beta wire, submit criteria with offer_filters, targeting_overlay, and required_overlay_support; compare supported and unsupported requirements, review sparse targeting_resolution modifications, and retain the proposal plus effective package targeting readback as evidence.');

SELECT _instrument_3_2_exercise('S1', 's1_ex1', 'list_products',
  'When the seller advertises the planning features, test a flexible availability_horizon and an outcome_target. Verify complete window coverage or disclosed incomplete gaps, total_budget_guidance, and a matching forecast metric without claiming that forecast guidance is a guarantee.');

SELECT _instrument_3_2_exercise('S2', 's2_ex1', 'sync_creatives',
  'Run the 3.2 canonical pixel-density and rendition reference cases, then submit VAST, accessibility, and provenance cases against the seller capabilities. Record the exact validation level and distinguish declared metadata from independently verified evidence.');

SELECT _instrument_3_2_exercise('S6', 's6_ex2', 'get_adcp_capabilities',
  'Read the 3.2 request_signing posture, then use the request-signing conformance vectors to demonstrate required content-digest coverage, exact-byte mismatch rejection, padded standard Base64 sf-binary parsing, and rejection of a legacy Base64URL request token without fallback.');

SELECT _instrument_3_2_exercise('S6', 's6_ex4', 'sync_accounts',
  'Capture webhook retry evidence showing buyer-supplied operation_id remains correlation while payload idempotency_key remains stable across exact retries; verify a changed logical fire gets a fresh payload key. Do not treat the SDK emitter delivery_id input as an MCP payload field.');

DROP FUNCTION _instrument_3_2_exercise(text, text, text, text);
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
        SELECT 1 FROM jsonb_array_elements(criteria) c
        WHERE c->>'id' = p_criterion_id
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

-- S1 — compact buying, targeting-aware discovery, and planning inputs.
SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_compact_media_buy_lifecycle',
  'Discovers advertised lifecycle_tools and completes the immutable request_proposals → refine_proposals → finalize → accept_proposal flow, using buy_products for direct offers and control_media_buy only for in-envelope operational changes.');

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_targeting_aware_discovery',
  'Separates concrete targeting_overlay values from required_overlay_support, filters products by binding overlay_support, reviews sparse targeting_resolution modifications before purchase, and verifies effective package targeting on readback.');

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_availability_and_outcome_planning',
  'Uses availability_horizon for flexible-window discovery and outcome_target for reverse forecasting, distinguishes forecast guidance from a delivery guarantee, and carries the selected priced product snapshot into purchase.');

-- S2 — 3.2 creative quality, interoperability, and provenance.
SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_pixel_density_and_renditions',
  'Selects logical dimensions and pixel_ratio correctly, validates intrinsic pixel dimensions, and distinguishes a required rendition set from optional creative variants or delivery-time resizing.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_vast_accessibility_provenance',
  'Applies the advertised VAST validation level, preserves required accessibility detail, and evaluates synthetic-depiction and provenance evidence while distinguishing declared metadata from independent verification.');

-- S6 — 3.2 request and webhook integrity changes.
SELECT _append_criterion('S6', 's6_ex2', 's6_ex2_sc_3_2_signed_body_integrity',
  'For a 3.2 request-signing endpoint, verifies that content-digest is covered on every body-bearing request and encodes Signature and Content-Digest binary values as RFC 8941 padded standard Base64 rather than the 3.0/3.1 Base64URL override.');

SELECT _append_criterion('S6', 's6_ex4', 's6_ex4_sc_webhook_delivery_identity',
  'Distinguishes buyer-supplied operation_id correlation from sender-generated webhook idempotency_key deduplication, preserves one payload key across retries of the same byte-identical logical fire, and uses a fresh payload key when the payload or lifecycle observation changes.');

DROP FUNCTION _append_criterion(text, text, text, text);
