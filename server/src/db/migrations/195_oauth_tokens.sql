-- Migration: 195_oauth_tokens.sql
-- Add OAuth token support for agent contexts
--
-- Extends agent_contexts to support OAuth 2.0 authentication:
-- - Access tokens (encrypted)
-- - Refresh tokens (encrypted)
-- - Token expiration
-- - OAuth client info (for dynamic registration)

-- Add OAuth token columns
ALTER TABLE agent_contexts
ADD COLUMN IF NOT EXISTS oauth_access_token_encrypted TEXT,
ADD COLUMN IF NOT EXISTS oauth_access_token_iv TEXT,
ADD COLUMN IF NOT EXISTS oauth_refresh_token_encrypted TEXT,
ADD COLUMN IF NOT EXISTS oauth_refresh_token_iv TEXT,
ADD COLUMN IF NOT EXISTS oauth_token_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS oauth_client_id TEXT,
ADD COLUMN IF NOT EXISTS oauth_client_secret_encrypted TEXT,
ADD COLUMN IF NOT EXISTS oauth_client_secret_iv TEXT;

-- Comments
COMMENT ON COLUMN agent_contexts.oauth_access_token_encrypted IS 'OAuth 2.0 access token (AES-256-GCM encrypted)';
COMMENT ON COLUMN agent_contexts.oauth_refresh_token_encrypted IS 'OAuth 2.0 refresh token (AES-256-GCM encrypted)';
COMMENT ON COLUMN agent_contexts.oauth_token_expires_at IS 'When the access token expires';
COMMENT ON COLUMN agent_contexts.oauth_client_id IS 'OAuth client ID from dynamic registration';
COMMENT ON COLUMN agent_contexts.oauth_client_secret_encrypted IS 'OAuth client secret (AES-256-GCM encrypted)';

-- Update the view to include OAuth status
DROP VIEW IF EXISTS agent_context_summary;

CREATE VIEW agent_context_summary AS
SELECT
  ac.id,
  ac.organization_id,
  ac.agent_url,
  ac.agent_name,
  ac.agent_type,
  ac.protocol,
  ac.auth_token_hint,
  ac.auth_token_encrypted IS NOT NULL as has_auth_token,
  ac.oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
  ac.oauth_token_expires_at,
  ac.oauth_client_id IS NOT NULL as has_oauth_client,
  ac.tools_discovered,
  ac.last_test_scenario,
  ac.last_test_passed,
  ac.last_test_summary,
  ac.last_tested_at,
  ac.total_tests_run,
  ac.created_at,
  ac.updated_at,
  -- Aggregated stats from history
  (SELECT COUNT(*) FROM agent_test_history h WHERE h.agent_context_id = ac.id) as history_count,
  (SELECT COUNT(*) FROM agent_test_history h WHERE h.agent_context_id = ac.id AND h.overall_passed) as history_passed_count
FROM agent_contexts ac;

COMMENT ON VIEW agent_context_summary IS 'Agent contexts with auth info and stats aggregated';
