-- Network consistency reports: stores per-crawl health snapshots comparing
-- an org's brand.json declarations against crawl reality.
-- Brand.json properties (with relationship: owned/direct/delegated/ad_network) define
-- the expected state; adagents.json crawl results provide the actual state.

CREATE TABLE IF NOT EXISTS network_consistency_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  brand_domain TEXT NOT NULL,              -- house domain from brand.json

  -- Summary metrics
  total_properties INTEGER NOT NULL DEFAULT 0,
  verified_properties INTEGER NOT NULL DEFAULT 0,   -- both sides agree
  missing_authorization INTEGER NOT NULL DEFAULT 0,  -- declared in brand.json, not in publisher's adagents.json
  orphaned_authorization INTEGER NOT NULL DEFAULT 0, -- in publisher's adagents.json, not declared in brand.json
  schema_errors INTEGER NOT NULL DEFAULT 0,
  coverage_pct NUMERIC(5,2) NOT NULL DEFAULT 0,      -- 0.00–100.00

  -- Per-property detail (array of property results)
  property_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Each entry: { identifier, type, relationship, verification_status, agent_authorized, errors[] }
  -- verification_status: verified | missing_authorization | orphaned | unreachable | error

  -- Agent health (per-agent endpoint checks)
  agent_health JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Each entry: { agent_url, agent_id, reachable, response_time_ms, error? }

  -- Schema validation errors on the brand.json itself
  schema_error_details JSONB NOT NULL DEFAULT '[]'::jsonb,

  crawl_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ncr_org_id ON network_consistency_reports(org_id);
CREATE INDEX IF NOT EXISTS idx_ncr_org_brand ON network_consistency_reports(org_id, brand_domain);
CREATE INDEX IF NOT EXISTS idx_ncr_created_at ON network_consistency_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ncr_org_created ON network_consistency_reports(org_id, created_at DESC);

-- Alert rules: configurable thresholds per org.

CREATE TABLE IF NOT EXISTS network_alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- Thresholds
  coverage_threshold NUMERIC(5,2) NOT NULL DEFAULT 95.00,
  missing_authorization_max INTEGER NOT NULL DEFAULT 0,
  orphaned_authorization_max INTEGER NOT NULL DEFAULT 0,
  agent_unreachable_cycles INTEGER NOT NULL DEFAULT 2,

  -- Notification channels
  slack_webhook_url TEXT,
  email_recipients TEXT[] DEFAULT ARRAY[]::TEXT[],

  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(org_id)
);

-- Alert history: audit log of fired alerts.

CREATE TABLE IF NOT EXISTS network_alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'coverage_drop', 'missing_authorization', 'orphaned_authorization',
    'schema_error', 'agent_unreachable'
  )),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_id UUID REFERENCES network_consistency_reports(id) ON DELETE SET NULL,
  notified_via TEXT[] DEFAULT ARRAY[]::TEXT[],

  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nah_org_id ON network_alert_history(org_id);
CREATE INDEX IF NOT EXISTS idx_nah_created_at ON network_alert_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nah_unresolved ON network_alert_history(org_id, resolved_at) WHERE resolved_at IS NULL;
