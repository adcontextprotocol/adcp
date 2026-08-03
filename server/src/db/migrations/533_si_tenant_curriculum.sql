-- Migration 533: /si training tenant — curriculum gaps and tenant pinning.
--
-- Installs three curriculum fixes that were blocked by the missing /si tenant:
--   1. C3 c3_ex2: replace connect_to_si_agent (Addie host tool) with
--      si_initiate_session (AdCP protocol task). Fix description and criteria.
--   2. S5 s5_ex1: restore si_get_offering and si_terminate_session to
--      sandbox_actions (dropped in migration 298, not restored in 303).
--      Add stable {id, text} criterion objects (plain-string criteria cannot
--      be targeted by the recertification delta engine).
--   3. Pin C3 tenant_ids = ['creative', 'si']; S5 tenant_ids = ['si'].
--      A3 stays NULL — it is a tour module with no per-tenant lab exercises.
--
-- Prerequisite: the /si tenant must be registered before Sage uses these
-- tenant_ids. The tenant is added in the same PR (tenants/si.ts,
-- v6-si-platform.ts, registry.ts).
--
-- ASTM E3416-24: Section 7 requires every performance condition in
-- exercise_definitions.sandbox_actions to correspond to a required
-- demonstration in assessment_criteria. s5_ex1 assessment dimension
-- "si_chat_competence" describes "Full session lifecycle from initiation
-- through offering to termination" as the high-score condition. Migration
-- 298 dropped si_get_offering and si_terminate_session; this migration
-- restores the required conditions.

-- ========================================================================
-- C3: fix SI exercise namespace, update description and criteria, pin tenant
-- ========================================================================

-- Replace c3_ex2 with corrected version: si_initiate_session in sandbox_actions.
-- c3_ex1 (creative format discovery and sync) is preserved unchanged.
DO $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  ex_id text;
  actions jsonb;
  new_actions jsonb;
  act jsonb;
BEGIN
  SELECT exercise_definitions INTO defs
  FROM certification_modules WHERE id = 'C3';

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'C3 exercise_definitions missing or not an array';
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs) LOOP
    ex_id := ex->>'id';

    IF ex_id = 'c3_ex2' THEN
      -- Replace connect_to_si_agent with si_initiate_session.
      actions := COALESCE(ex->'sandbox_actions', '[]'::jsonb);
      new_actions := '[]'::jsonb;

      FOR act IN SELECT * FROM jsonb_array_elements(actions) LOOP
        IF act->>'tool' = 'connect_to_si_agent' THEN
          act := jsonb_set(act, '{tool}', '"si_initiate_session"');
          act := jsonb_set(act, '{guidance}',
            '"Initiate an SI Chat Protocol session with a sandbox brand agent. Supply intent and identity. Observe the session_id, brand greeting, and supported UI capabilities in the response. This is the AdCP buyer-side protocol task — not Addie''s internal connect_to_si_agent host tool."');
        END IF;
        new_actions := new_actions || jsonb_build_array(act);
      END LOOP;

      ex := jsonb_set(ex, '{sandbox_actions}', new_actions);
      ex := jsonb_set(ex, '{description}',
        '"Explore the SI Chat Protocol by calling si_initiate_session against the /si training tenant. si_initiate_session is the AdCP protocol task that starts a brand conversation session — the buyer-side entry point into Sponsored Intelligence."');
      ex := jsonb_set(ex, '{success_criteria}', '[
        "Successfully calls si_initiate_session and receives a session_id and brand agent welcome message",
        "Can explain how the SI Chat Protocol differs from traditional display or video advertising",
        "Can distinguish si_initiate_session (AdCP buyer protocol task) from connect_to_si_agent (Addie host-side tool for end-user product experiences)"
      ]'::jsonb);
    END IF;

    updated := updated || jsonb_build_array(ex);
  END LOOP;

  UPDATE certification_modules SET exercise_definitions = updated WHERE id = 'C3';
END $$;

-- Pin C3 to creative + si tenants now that /si exists.
-- creative for c3_ex1 (list_creative_formats, sync_creatives);
-- si for c3_ex2 (si_initiate_session).
UPDATE certification_modules
  SET tenant_ids = ARRAY['creative', 'si']
WHERE id = 'C3';


-- ========================================================================
-- S5: restore full SI lifecycle to sandbox_actions; stable criterion IDs;
--     pin to si tenant
-- ========================================================================

-- Full replacement of s5_ex1. Adds si_get_offering (pre-session offering
-- discovery) and si_terminate_session (session close) that migration 298
-- dropped. Success criteria are converted from plain strings to {id, text}
-- objects so the recertification delta engine has stable criterion handles.
UPDATE certification_modules SET
  exercise_definitions = '[
    {
      "id": "s5_ex1",
      "title": "Sponsored Intelligence end-to-end",
      "description": "Build generative creative, execute a Sponsored Intelligence campaign, and exercise the complete SI Chat Protocol session lifecycle: si_get_offering → si_initiate_session → si_send_message → si_terminate_session.",
      "sandbox_actions": [
        {"tool": "list_creative_formats", "guidance": "Discover available generative creative formats."},
        {"tool": "build_creative", "guidance": "Generate a creative from brand assets and a brief."},
        {"tool": "sync_catalogs", "guidance": "Push a product catalog to the AI platform."},
        {"tool": "get_products", "guidance": "Discover Sponsored Intelligence products."},
        {"tool": "create_media_buy", "guidance": "Create a Sponsored Intelligence media buy with optimization goals."},
        {"tool": "si_get_offering", "guidance": "Get offering details and availability from the brand agent before initiating a session. Note the offering_token in the response for session continuity."},
        {"tool": "si_initiate_session", "guidance": "Start an SI Chat Protocol brand conversation session, passing the offering_token from si_get_offering."},
        {"tool": "si_send_message", "guidance": "Exchange messages in the brand conversation. Observe product cards, carousels, and action buttons in the response."},
        {"tool": "si_terminate_session", "guidance": "End the SI Chat Protocol session with an appropriate reason code (user_exit, handoff_complete, handoff_transaction, etc.). Understand when each reason applies."}
      ],
      "success_criteria": [
        {"id": "s5_ex1_sc_generative_creative", "text": "Generates creative from brand assets and catalog data"},
        {"id": "s5_ex1_sc_reversed_data_flow", "text": "Understands the reversed data flow and can articulate why Sponsored Intelligence buyers push data in rather than receive bid requests"},
        {"id": "s5_ex1_sc_catalog_sync", "text": "Successfully syncs catalogs before creating a media buy and explains why catalog richness affects creative quality"},
        {"id": "s5_ex1_sc_offering_integration", "text": "Calls si_get_offering before si_initiate_session and threads the offering_token through to enable session continuity"},
        {"id": "s5_ex1_sc_session_lifecycle", "text": "Completes the full four-step SI Chat Protocol lifecycle: si_get_offering, si_initiate_session, si_send_message, si_terminate_session"},
        {"id": "s5_ex1_sc_terminated_gracefully", "text": "Terminates the session with a semantically correct reason code and can explain when user_exit, handoff_complete, and handoff_transaction each apply"},
        {"id": "s5_ex1_sc_strategic_fit", "text": "Can explain when Sponsored Intelligence fits vs traditional programmatic approaches and articulate the economic difference between CPC/CPE pricing and CPM"}
      ]
    }
  ]',
  tenant_ids = ARRAY['si']
WHERE id = 'S5';
