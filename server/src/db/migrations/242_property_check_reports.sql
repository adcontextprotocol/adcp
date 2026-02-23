-- Stores results from property list checks, retrievable by ID.
-- Allows MCP tools to return a compact summary and URL rather than
-- dumping thousands of domain entries into the agent context.

CREATE TABLE IF NOT EXISTS property_check_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_property_check_reports_expires_at
  ON property_check_reports (expires_at);
