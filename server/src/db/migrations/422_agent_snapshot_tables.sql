-- Materialized per-agent health and capability snapshots.
--
-- Written by the crawler on each cycle; read in bulk by the public
-- /registry/agents endpoint. Mirrors the agent_compliance_status pattern:
-- one row per agent_url, single ANY($1) query for the registry page.
-- Removes the need to fan out live MCP/A2A calls on page load.

CREATE TABLE IF NOT EXISTS agent_health_snapshot (
  agent_url TEXT PRIMARY KEY,
  online BOOLEAN NOT NULL,
  response_time_ms INTEGER,
  tools_count INTEGER,
  resources_count INTEGER,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL,
  stats_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_health_snapshot_checked_at
  ON agent_health_snapshot(checked_at DESC);

CREATE TABLE IF NOT EXISTS agent_capabilities_snapshot (
  agent_url TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  discovered_tools_json JSONB NOT NULL DEFAULT '[]',
  standard_operations_json JSONB,
  creative_capabilities_json JSONB,
  signals_capabilities_json JSONB,
  inferred_type TEXT,
  discovery_error TEXT,
  oauth_required BOOLEAN NOT NULL DEFAULT FALSE,
  last_discovered TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_snapshot_protocol CHECK (protocol IN ('mcp', 'a2a'))
);

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_snapshot_last_discovered
  ON agent_capabilities_snapshot(last_discovered DESC);
