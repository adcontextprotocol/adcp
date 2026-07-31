-- Canonical format kind projection for registry agent search.
-- Keep the deprecated format_ids JSONB column during the 3.x compatibility
-- window, but do not derive canonical API output from its legacy contents.

ALTER TABLE agent_inventory_profiles
  ADD COLUMN IF NOT EXISTS format_kinds TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_aip_format_kinds
  ON agent_inventory_profiles USING GIN (format_kinds);

UPDATE agent_inventory_profiles profile
SET format_kinds = canonical.kinds
FROM (
  SELECT
    snapshot.agent_url,
    ARRAY_AGG(DISTINCT capability->'format'->>'format_kind'
              ORDER BY capability->'format'->>'format_kind') AS kinds
  FROM agent_capabilities_snapshot snapshot
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(snapshot.creative_capabilities_json->'supported_formats') = 'array'
        THEN snapshot.creative_capabilities_json->'supported_formats'
      ELSE '[]'::jsonb
    END
  ) capability
  WHERE NULLIF(capability->'format'->>'format_kind', '') IS NOT NULL
  GROUP BY snapshot.agent_url
) canonical
WHERE profile.agent_url = canonical.agent_url;
