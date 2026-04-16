-- Add indexes on expires_at for OAuth cleanup jobs.
-- These tables are cleaned every 5 minutes with DELETE WHERE expires_at <= NOW().
-- Without an index, each cleanup does a full table scan and holds locks longer
-- than necessary, contributing to pool contention under load.

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_pending_auths_expires
  ON mcp_oauth_pending_auths(expires_at);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_auth_codes_expires
  ON mcp_oauth_auth_codes(expires_at);

CREATE INDEX IF NOT EXISTS idx_agent_oauth_pending_flows_expires
  ON agent_oauth_pending_flows(expires_at);
