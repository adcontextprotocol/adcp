-- Restore 'sales' agent type that was incorrectly dropped in migration 387.
-- Sales agents (sell-side) and buying agents (buy-side) are distinct types.

ALTER TABLE agent_contexts DROP CONSTRAINT IF EXISTS agent_contexts_agent_type_check;

ALTER TABLE agent_contexts ADD CONSTRAINT agent_contexts_agent_type_check
  CHECK (agent_type IN ('brand', 'rights', 'measurement', 'governance', 'creative', 'sales', 'buying', 'signals', 'unknown'));
