-- Migration: 227_agent_oauth_pending_flows.sql
-- Persist agent OAuth pending flow state in PostgreSQL for multi-instance support.

CREATE TABLE IF NOT EXISTS agent_oauth_pending_flows (
  state TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_oauth_pending_flows IS 'Pending agent OAuth authorization flows awaiting callback';
