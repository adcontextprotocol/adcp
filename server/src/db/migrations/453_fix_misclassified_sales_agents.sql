-- Fix sales agents misclassified as 'buying' in the federated discovery index.
--
-- Migration 387 renamed sales -> buying everywhere. Migration 392 restored
-- 'sales' as a valid agent_type but did not back-fill discovered_agents, and
-- the inference code in server/src/capabilities.ts continued to return
-- 'buying' for SALES_TOOLS (get_products / create_media_buy /
-- list_authorized_properties). Every row in discovered_agents with
-- agent_type = 'buying' was inferred from those sales tools and is therefore
-- a sell-side agent, not a buy-side agent.
--
-- The crawler's refreshAgentSnapshots only re-infers when the existing type
-- is 'unknown', so without this back-fill the misclassification is sticky
-- even after the inference fix in capabilities.ts.

UPDATE discovered_agents SET agent_type = 'sales' WHERE agent_type = 'buying';
