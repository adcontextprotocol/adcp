-- Align agent types with brand.json schema (brand-agent-type.json enum).
-- Renames: sales → buying, si → brand
-- Adds: brand, rights, measurement, buying

-- Update agent_contexts CHECK constraint
ALTER TABLE agent_contexts DROP CONSTRAINT IF EXISTS agent_contexts_agent_type_check;
ALTER TABLE agent_contexts ADD CONSTRAINT agent_contexts_agent_type_check
  CHECK (agent_type IN ('brand', 'rights', 'measurement', 'governance', 'creative', 'buying', 'signals', 'unknown'));

-- Migrate existing data
UPDATE agent_contexts SET agent_type = 'buying' WHERE agent_type = 'sales';
UPDATE agent_contexts SET agent_type = 'brand' WHERE agent_type = 'si';

-- Migrate discovered agents in federated index
UPDATE discovered_agents SET agent_type = 'buying' WHERE agent_type = 'sales';
UPDATE discovered_agents SET agent_type = 'brand' WHERE agent_type = 'si';

-- Migrate agent types stored in member_profiles.agents JSONB array
UPDATE member_profiles
SET agents = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'type' = 'sales' THEN jsonb_set(elem, '{type}', '"buying"')
      WHEN elem->>'type' = 'si' THEN jsonb_set(elem, '{type}', '"brand"')
      ELSE elem
    END
  )
  FROM jsonb_array_elements(agents) elem
)
WHERE agents IS NOT NULL
  AND agents != '[]'::jsonb
  AND (
    agents::text LIKE '%"sales"%'
    OR agents::text LIKE '%"si"%'
  );
