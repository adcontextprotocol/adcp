-- Appends 3.0-specific success_criteria to existing module exercises with semantic
-- IDs the recertification engine can target. Each criterion captures a material
-- rc.3 → 3.0 paradigm shift so learners certified against the prior behavior can
-- be flagged individually.
--
-- ID convention: {module}_{exercise}_sc_{concept}

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

-- C1: Buyer practitioner — multi-agent orchestration
SELECT _append_criterion('C1', 'c1_ex2', 'c1_ex2_sc_version_declaration',
  'Declares adcp_major_version on create_media_buy requests and handles VERSION_UNSUPPORTED by selecting a compatible seller or downgrading the payload.');

SELECT _append_criterion('C1', 'c1_ex2', 'c1_ex2_sc_update_media_buy_account',
  'Includes account on every update_media_buy call so billing resolves to the correct relationship.');

SELECT _append_criterion('C1', 'c1_ex2', 'c1_ex2_sc_measurement_terms_negotiation',
  'Proposes measurement_terms on a guaranteed buy, interprets seller acceptance vs adjustment vs TERMS_REJECTED, and recovers by aligning to a supported vendor or product defaults.');

-- C2: Buyer practitioner — brand identity and compliance
SELECT _append_criterion('C2', 'c2_ex2', 'c2_ex2_sc_governance_denied_recovery',
  'Handles GOVERNANCE_DENIED by reading governance_context, identifying the failed rule, correcting targeting or creative, and retrying — not treating it as a transport error.');

SELECT _append_criterion('C2', 'c2_ex2', 'c2_ex2_sc_purchase_type_awareness',
  'Identifies purchase_type (media_buy, rights_license, signal_activation, creative_services) for each governed action so the governance agent applies the right rules.');

-- C3: Buyer practitioner — creative workflows
SELECT _append_criterion('C3', 'c3_ex1', 'c3_ex1_sc_preview_creative_modes',
  'Uses preview_creative in single, batch, and variant modes; chooses output_format="html" when rendering speed matters.');

SELECT _append_criterion('C3', 'c3_ex1', 'c3_ex1_sc_industry_identifiers',
  'Attaches industry_identifiers[] with the correct creative-identifier-type (ad_id, isci, clearcast_clock) on broadcast manifests and assigns a distinct Ad-ID to each cut.');

-- B1: Publisher practitioner — building your sales agent
SELECT _append_criterion('B1', 'b1_ex1', 'b1_ex1_sc_version_negotiation',
  'Sales agent advertises adcp.major_versions in get_adcp_capabilities, validates incoming adcp_major_version, and returns VERSION_UNSUPPORTED when out of range.');

SELECT _append_criterion('B1', 'b1_ex1', 'b1_ex1_sc_object_presence_capabilities',
  'Declares capabilities by object presence, not booleans; omits unsupported feature objects rather than setting them to false.');

-- B3: Publisher practitioner — measurement, reporting, optimization
SELECT _append_criterion('B3', 'b3_ex1', 'b3_ex1_sc_reporting_capabilities_required',
  'Every product includes reporting_capabilities declaring metrics, dimensions, cadence, and measurement windows; presence of the object declares get_media_buy_delivery support.');

SELECT _append_criterion('B3', 'b3_ex1', 'b3_ex1_sc_lifecycle_transitions',
  'Transitions media buys through pending_creatives → pending_start → active correctly, notifies orchestrators on transitions via webhook, and restricts seller-initiated rejection to the pending states.');

-- S1: Specialist media buy
SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_state_machine_lifecycle',
  'Traces a media buy through pending_creatives → pending_start → active, explains which valid_actions apply in each state, and handles the pending-only rejection rule.');

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_pricing_options_selection',
  'Selects a pricing_option_id from a product pricing_options[] array (CPM, vCPM, CPP, CPA, flat rate, time) and explains why the model''s parameters matter for the buy.');

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_terms_negotiation',
  'Proposes measurement_terms and performance_standards, interprets seller response (accept, adjust, TERMS_REJECTED), and recovers by aligning to supported vendors or defaults.');

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_update_media_buy_account',
  'Calls update_media_buy with account + media_buy_id (both required in 3.0); omitting account is a protocol error.');

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_agency_estimate_number',
  'Attaches agency_estimate_number at buy or package level for broadcast buys; package-level overrides buy-level when flights or stations differ.');

-- S3: Specialist signals
SELECT _append_criterion('S3', 's3_ex1', 's3_ex1_sc_pricing_options_signals',
  'Reads pricing_options[] from get_signals responses and passes the selected pricing_option_id through activate_signal and report_usage.');

-- S2: Specialist creative
SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_pricing_options_creative',
  'Reads pricing_options[] on list_creatives or list_creative_formats responses and closes the loop with pricing_option_id on build_creative and report_usage.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_tracker_slot_reasoning',
  'Determines whether a format supports third-party measurement by inspecting its assets array for a tracker slot; explains why broadcast formats omit tracker slots and rely on billing_measurement vendors instead.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_broadcast_identifiers',
  'Attaches industry_identifiers[] with correct creative-identifier-type values on broadcast manifests and gives each cut (:15, :30) its own Ad-ID.');

SELECT _append_criterion('S2', 's2_ex1', 's2_ex1_sc_preview_creative_modes',
  'Uses preview_creative in single, batch (5–10× speedup), and variant modes; chooses output_format="html" vs "url" with rationale.');

-- S4: Specialist governance
SELECT _append_criterion('S4', 's4_ex1', 's4_ex1_sc_governance_context_correlation',
  'Explains the governance_context correlation model: agent issues opaque token on first check; buyer attaches it to the media buy envelope; seller echoes it on execution checks so the agent reconnects each lifecycle event without re-deriving state.');

SELECT _append_criterion('S4', 's4_ex1', 's4_ex1_sc_purchase_type_variation',
  'Applies governance across purchase_type values (media_buy, rights_license, signal_activation, creative_services); identifies which validations are shared vs media-buy-specific.');

SELECT _append_criterion('S4', 's4_ex1', 's4_ex1_sc_three_layer_distinction',
  'Distinguishes property lists (where), collection lists (what content), and content standards (per-impression adjacency), and chooses the correct layer for a given brand-safety problem.');

SELECT _append_criterion('S4', 's4_ex1', 's4_ex1_sc_governance_denied_recovery',
  'Handles GOVERNANCE_DENIED end-to-end: reads the denial reason, corrects the payload (targeting, creative, or plan reference), and verifies a retry passes.');

-- Foundations: A2 — object-presence and version negotiation
SELECT _append_criterion('A2', 'a2_ex1', 'a2_ex1_sc_object_presence_principle',
  'Explains that AdCP capabilities are declared by object presence, not booleans: if a feature is supported, the object is present; if not, it is omitted. Buyers check object presence, not a value.');

SELECT _append_criterion('A2', 'a2_ex1', 'a2_ex1_sc_version_negotiation',
  'Explains how adcp_major_version on requests and adcp.major_versions on get_adcp_capabilities let buyers and sellers negotiate compatibility, and that VERSION_UNSUPPORTED is returned on mismatch.');

DROP FUNCTION _append_criterion(text, text, text, text);
