-- Community governance agent state tables
-- Stores plans, governance checks, outcomes, and credentials for the AAO community governance agent

-- Bearer token credentials for governance agent authentication.
-- Buyers register tokens via sync_accounts; sellers present them when calling check_governance.
-- Token is stored as a SHA-256 hash — the raw token is never persisted.
CREATE TABLE IF NOT EXISTS governance_credentials (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_governance_credentials_account ON governance_credentials(account_id);

-- Plans synced by orchestrators
CREATE TABLE IF NOT EXISTS governance_plans (
  plan_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  brand_domain TEXT NOT NULL,
  brand_id TEXT,
  objectives TEXT NOT NULL,
  budget_total NUMERIC NOT NULL,
  budget_currency TEXT NOT NULL,
  budget_authority_level TEXT NOT NULL CHECK (budget_authority_level IN ('agent_full', 'agent_limited', 'human_required')),
  budget_per_seller_max_pct NUMERIC,
  budget_reallocation_threshold NUMERIC,
  channels_required JSONB DEFAULT '[]'::jsonb,
  channels_allowed JSONB DEFAULT '[]'::jsonb,
  channel_mix_targets JSONB DEFAULT '{}'::jsonb,
  flight_start TIMESTAMPTZ NOT NULL,
  flight_end TIMESTAMPTZ NOT NULL,
  countries JSONB DEFAULT '[]'::jsonb,
  regions JSONB DEFAULT '[]'::jsonb,
  approved_sellers JSONB,
  resolved_policies JSONB DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'completed')),
  ext JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_plans_account ON governance_plans(account_id);
CREATE INDEX IF NOT EXISTS idx_governance_plans_brand ON governance_plans(brand_domain);

-- Governance check records
CREATE TABLE IF NOT EXISTS governance_checks (
  check_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES governance_plans(plan_id),
  buyer_campaign_ref TEXT NOT NULL,
  binding TEXT NOT NULL CHECK (binding IN ('proposed', 'committed')),
  caller TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'purchase' CHECK (phase IN ('purchase', 'modification', 'delivery')),
  tool TEXT,
  payload JSONB,
  media_buy_id TEXT,
  buyer_ref TEXT,
  planned_delivery JSONB,
  delivery_metrics JSONB,
  modification_summary TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved', 'denied', 'conditions', 'escalated')),
  explanation TEXT NOT NULL,
  findings JSONB DEFAULT '[]'::jsonb,
  conditions JSONB,
  escalation JSONB,
  expires_at TIMESTAMPTZ,
  next_check TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_checks_plan ON governance_checks(plan_id);
CREATE INDEX IF NOT EXISTS idx_governance_checks_campaign ON governance_checks(plan_id, buyer_campaign_ref);
CREATE INDEX IF NOT EXISTS idx_governance_checks_media_buy ON governance_checks(media_buy_id) WHERE media_buy_id IS NOT NULL;

-- Outcome records from report_plan_outcome
CREATE TABLE IF NOT EXISTS governance_outcomes (
  outcome_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES governance_plans(plan_id),
  check_id TEXT REFERENCES governance_checks(check_id),
  buyer_campaign_ref TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'delivery')),
  seller_response JSONB,
  delivery JSONB,
  error JSONB,
  committed_budget NUMERIC,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'findings')),
  findings JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_outcomes_plan ON governance_outcomes(plan_id);
CREATE INDEX IF NOT EXISTS idx_governance_outcomes_campaign ON governance_outcomes(plan_id, buyer_campaign_ref);

-- Budget tracking view for quick lookups
CREATE OR REPLACE VIEW governance_budget_summary AS
SELECT
  p.plan_id,
  p.budget_total,
  p.budget_currency,
  COALESCE(SUM(o.committed_budget) FILTER (WHERE o.outcome = 'completed'), 0) AS total_committed,
  p.budget_total - COALESCE(SUM(o.committed_budget) FILTER (WHERE o.outcome = 'completed'), 0) AS budget_remaining
FROM governance_plans p
LEFT JOIN governance_outcomes o ON o.plan_id = p.plan_id
GROUP BY p.plan_id, p.budget_total, p.budget_currency;
