-- Network consistency reports: stores per-crawl health snapshots for managed publisher networks.
-- Consumed by the network health dashboard and alerting system.

CREATE TABLE IF NOT EXISTS network_consistency_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authoritative_url TEXT NOT NULL,           -- URL of the authoritative adagents.json
  org_id TEXT REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,

  -- Summary metrics
  total_properties INTEGER NOT NULL DEFAULT 0,
  valid_pointers INTEGER NOT NULL DEFAULT 0,
  missing_pointers INTEGER NOT NULL DEFAULT 0,
  orphaned_pointers INTEGER NOT NULL DEFAULT 0,
  stale_pointers INTEGER NOT NULL DEFAULT 0,
  schema_errors INTEGER NOT NULL DEFAULT 0,
  coverage_pct NUMERIC(5,2) NOT NULL DEFAULT 0,   -- 0.00–100.00

  -- Per-domain detail (array of domain results)
  domain_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Each entry: { domain, pointer_status, matched_property, authorized_agents[], errors[] }

  -- Agent health (per-agent endpoint checks)
  agent_health JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Each entry: { agent_url, reachable, response_time_ms, error? }

  -- Schema validation errors on the authoritative file itself
  schema_error_details JSONB NOT NULL DEFAULT '[]'::jsonb,

  crawl_id TEXT,                              -- links to the crawl run that produced this report
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ncr_authoritative_url ON network_consistency_reports(authoritative_url);
CREATE INDEX IF NOT EXISTS idx_ncr_org_id ON network_consistency_reports(org_id);
CREATE INDEX IF NOT EXISTS idx_ncr_created_at ON network_consistency_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ncr_auth_url_created ON network_consistency_reports(authoritative_url, created_at DESC);

-- Alert rules: configurable thresholds per authoritative URL.

CREATE TABLE IF NOT EXISTS network_alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authoritative_url TEXT NOT NULL,
  org_id TEXT REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,

  -- Thresholds
  coverage_threshold NUMERIC(5,2) NOT NULL DEFAULT 95.00,     -- alert if coverage drops below
  stale_pointer_max INTEGER NOT NULL DEFAULT 0,                -- alert if stale pointers exceed
  orphaned_pointer_max INTEGER NOT NULL DEFAULT 0,             -- alert if orphaned pointers exceed
  missing_pointer_persistence_cycles INTEGER NOT NULL DEFAULT 2, -- alert after N crawl cycles
  agent_unreachable_cycles INTEGER NOT NULL DEFAULT 2,           -- alert after N crawl cycles

  -- Notification channels
  slack_webhook_url TEXT,
  email_recipients TEXT[] DEFAULT ARRAY[]::TEXT[],

  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(authoritative_url)
);

CREATE INDEX IF NOT EXISTS idx_nar_org_id ON network_alert_rules(org_id);

-- Alert history: audit log of fired alerts.

CREATE TABLE IF NOT EXISTS network_alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authoritative_url TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'coverage_drop', 'orphaned_pointer', 'stale_pointer',
    'schema_error', 'agent_unreachable', 'missing_pointer_persistent'
  )),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_id UUID REFERENCES network_consistency_reports(id) ON DELETE SET NULL,
  notified_via TEXT[] DEFAULT ARRAY[]::TEXT[],  -- 'slack', 'email'

  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nah_authoritative_url ON network_alert_history(authoritative_url);
CREATE INDEX IF NOT EXISTS idx_nah_created_at ON network_alert_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nah_unresolved ON network_alert_history(authoritative_url, resolved_at) WHERE resolved_at IS NULL;
