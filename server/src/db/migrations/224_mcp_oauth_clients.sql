-- Migration: 224_mcp_oauth_clients.sql
-- Persist MCP OAuth registered clients in PostgreSQL
--
-- MCP clients (e.g., Claude) use dynamic client registration to obtain a client_id.
-- Previously stored in-memory, which meant registrations were lost on server restart.
-- Clients cache their client_id and reuse it, causing "invalid_client" errors after deploys.

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_info JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE mcp_oauth_clients IS 'Registered MCP OAuth clients (dynamic client registration per RFC 7591)';
COMMENT ON COLUMN mcp_oauth_clients.client_info IS 'Full OAuthClientInformationFull object from MCP SDK';
