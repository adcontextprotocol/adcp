-- Migration: 246_prospect_triage_log.sql
-- Tracks all triage decisions (including skips) for quality measurement

CREATE TABLE IF NOT EXISTS prospect_triage_log (
  id SERIAL PRIMARY KEY,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'skip' or 'create'
  reason TEXT,                    -- short reason code
  owner TEXT,                     -- 'addie' or 'human'
  priority TEXT,                  -- 'high' or 'standard'
  verdict TEXT,                   -- Claude's assessment
  company_name TEXT,
  company_type TEXT,
  source TEXT,                    -- 'slack', 'inbound', etc.
  enriched BOOLEAN DEFAULT FALSE, -- whether Lusha data was available
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triage_log_domain ON prospect_triage_log(domain);
CREATE INDEX IF NOT EXISTS idx_triage_log_action ON prospect_triage_log(action);
CREATE INDEX IF NOT EXISTS idx_triage_log_created ON prospect_triage_log(created_at);

COMMENT ON TABLE prospect_triage_log IS 'Audit log of all prospect triage decisions for quality tracking';
