-- Migration: 226_mcp_oauth_state.sql
-- Persist MCP OAuth pending authorizations and authorization codes in PostgreSQL
--
-- Pending auths hold state between the authorize redirect and the callback.
-- Auth codes hold tokens between code issuance and the token exchange.

CREATE TABLE IF NOT EXISTS mcp_oauth_pending_auths (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
  code TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE mcp_oauth_pending_auths IS 'Pending MCP OAuth authorization requests awaiting WorkOS callback';
COMMENT ON TABLE mcp_oauth_auth_codes IS 'MCP OAuth authorization codes awaiting exchange by MCP clients';
