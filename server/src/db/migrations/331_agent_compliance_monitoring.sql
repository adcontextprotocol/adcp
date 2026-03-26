-- Agent compliance monitoring: lifecycle metadata, compliance runs, and materialized status.

-- Registry-level metadata for any agent URL (registered or discovered).
-- Separate from member_profiles and discovered_agents — merged at query time.
CREATE TABLE agent_registry_metadata (
  agent_url TEXT PRIMARY KEY,
  lifecycle_stage TEXT NOT NULL DEFAULT 'production',
  compliance_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_lifecycle_stage CHECK (
    lifecycle_stage IN ('development', 'testing', 'production', 'deprecated')
  )
);

-- History of compliance heartbeat runs (one row per check).
CREATE TABLE agent_compliance_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_url TEXT NOT NULL,
  lifecycle_stage TEXT NOT NULL,

  -- Overall result
  overall_status TEXT NOT NULL,
  headline TEXT,
  total_duration_ms INTEGER,
  tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Per-track results: [{track, status, scenario_count, passed_count, duration_ms, observations}]
  tracks_json JSONB NOT NULL DEFAULT '[]',

  -- Summary counts
  tracks_passed INTEGER NOT NULL DEFAULT 0,
  tracks_failed INTEGER NOT NULL DEFAULT 0,
  tracks_skipped INTEGER NOT NULL DEFAULT 0,
  tracks_partial INTEGER NOT NULL DEFAULT 0,

  -- Agent profile snapshot
  agent_profile_json JSONB,

  -- Advisory observations
  observations_json JSONB,

  -- Source metadata
  triggered_by TEXT NOT NULL DEFAULT 'heartbeat',
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT valid_overall_status CHECK (
    overall_status IN ('passing', 'failing', 'partial')
  ),
  CONSTRAINT valid_triggered_by CHECK (
    triggered_by IN ('heartbeat', 'manual', 'webhook')
  )
);

CREATE INDEX idx_compliance_runs_agent_time ON agent_compliance_runs(agent_url, tested_at DESC);

-- Materialized current compliance status (computed from latest run + history).
-- One row per agent URL — fast reads for registry API.
CREATE TABLE agent_compliance_status (
  agent_url TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TIMESTAMPTZ,
  last_passed_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  streak_days INTEGER NOT NULL DEFAULT 0,
  streak_started_at TIMESTAMPTZ,

  -- Latest track breakdown: {core: 'pass', products: 'fail', ...}
  tracks_summary_json JSONB,
  headline TEXT,

  -- Change detection for notifications
  previous_status TEXT,
  status_changed_at TIMESTAMPTZ,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (
    status IN ('passing', 'degraded', 'failing', 'unknown')
  )
);
