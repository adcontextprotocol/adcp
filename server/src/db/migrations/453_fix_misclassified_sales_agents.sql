-- Fix sales agents misclassified as 'buying' in the federated discovery index.
--
-- Migration 387 renamed sales -> buying everywhere. Migration 392 restored
-- 'sales' as a valid agent_type but did not back-fill discovered_agents, and
-- the inference code in server/src/capabilities.ts continued to return
-- 'buying' for SALES_TOOLS (get_products / create_media_buy /
-- list_authorized_properties). Every row with the value 'buying' in either
-- table below was inferred from those sales tools and is therefore a sell-
-- side agent, not a buy-side agent.
--
-- Two tables need fixing:
--
--   1. discovered_agents.agent_type
--      The crawler's refreshAgentSnapshots only re-infers when the existing
--      type is 'unknown', so without this back-fill the misclassification
--      is sticky even after the inference fix in capabilities.ts.
--
--   2. agent_capabilities_snapshot.inferred_type
--      Read by registry-api.ts:3465-3467 (to fill in agent type when the
--      registered type is 'unknown') and by the prevention layer in PR
--      #3498's resolveAgentTypes() (as the authoritative type source for
--      every member-profile write). Stale 'buying' values here would cause
--      the prevention layer to OVERRIDE a correctly client-supplied 'sales'
--      back to 'buying' for any agent probed before the inference fix
--      shipped. Same root cause, same fix.

UPDATE discovered_agents
  SET agent_type = 'sales'
  WHERE agent_type = 'buying';

UPDATE agent_capabilities_snapshot
  SET inferred_type = 'sales'
  WHERE inferred_type = 'buying';
