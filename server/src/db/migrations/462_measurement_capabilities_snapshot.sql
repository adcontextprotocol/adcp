-- Adds measurement_capabilities_json to agent_capabilities_snapshot.
--
-- Holds the parsed `measurement` block from each agent's
-- `get_adcp_capabilities` response (added in AdCP 3.x via PR #3652) so the
-- /api/registry/agents endpoint can filter by metric_id / accreditation
-- without fanning out live MCP/A2A calls per request. Crawler writes;
-- read in bulk by `bulkGetCapabilities`.
--
-- Hard 256 KB ceiling on the column — a hostile vendor publishing a
-- multi-megabyte capabilities response would otherwise poison the public
-- listing. Per-row caps (metrics.length, field lengths) are enforced
-- application-side at write time; this CHECK is the belt-and-braces backstop.

ALTER TABLE agent_capabilities_snapshot
  ADD COLUMN IF NOT EXISTS measurement_capabilities_json JSONB;

ALTER TABLE agent_capabilities_snapshot
  DROP CONSTRAINT IF EXISTS measurement_capabilities_size_cap;

ALTER TABLE agent_capabilities_snapshot
  ADD CONSTRAINT measurement_capabilities_size_cap
  CHECK (
    measurement_capabilities_json IS NULL
    OR octet_length(measurement_capabilities_json::text) < 262144
  );

-- GIN index for JSONB containment queries (`@>` for metric_id and
-- accrediting_body matching).
CREATE INDEX IF NOT EXISTS idx_agent_capabilities_snapshot_measurement_gin
  ON agent_capabilities_snapshot
  USING GIN (measurement_capabilities_json);
