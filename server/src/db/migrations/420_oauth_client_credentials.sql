-- Migration: 419_oauth_client_credentials.sql
-- OAuth 2.0 client-credentials (RFC 6749 §4.4) support for agent contexts
--
-- Complements the authorization-code flow already in place (migration 195):
-- where auth-code flow requires a human to authorize once and we hold a
-- long-lived refresh token, client-credentials flow is machine-to-machine.
-- The server stores the token endpoint + client credentials and the SDK
-- exchanges at `@adcp/client`-level before every call, refreshing on 401.
--
-- Stored fields mirror @adcp/client's AgentOAuthClientCredentials shape.
-- The `oauth_cc_client_secret` column stores either the literal secret or a
-- `$ENV:VAR_NAME` reference — the SDK resolves the reference at exchange
-- time. Either way we encrypt at rest for uniform handling.

ALTER TABLE agent_contexts
ADD COLUMN IF NOT EXISTS oauth_cc_token_endpoint TEXT,
ADD COLUMN IF NOT EXISTS oauth_cc_client_id TEXT,
ADD COLUMN IF NOT EXISTS oauth_cc_client_secret_encrypted TEXT,
ADD COLUMN IF NOT EXISTS oauth_cc_client_secret_iv TEXT,
ADD COLUMN IF NOT EXISTS oauth_cc_scope TEXT,
ADD COLUMN IF NOT EXISTS oauth_cc_resource TEXT,
ADD COLUMN IF NOT EXISTS oauth_cc_audience TEXT,
ADD COLUMN IF NOT EXISTS oauth_cc_auth_method TEXT;

COMMENT ON COLUMN agent_contexts.oauth_cc_token_endpoint IS 'OAuth 2.0 token endpoint URL for client-credentials exchange (RFC 6749 §4.4). HTTPS-only in production.';
COMMENT ON COLUMN agent_contexts.oauth_cc_client_id IS 'OAuth client ID (RFC 6749 §2.2 — public identifier, not a secret).';
COMMENT ON COLUMN agent_contexts.oauth_cc_client_secret_encrypted IS 'OAuth client secret, AES-256-GCM encrypted. Value is either a literal secret or a `$ENV:VAR_NAME` reference (SDK resolves at exchange time).';
COMMENT ON COLUMN agent_contexts.oauth_cc_scope IS 'Space-separated OAuth scope values requested at token exchange (optional).';
COMMENT ON COLUMN agent_contexts.oauth_cc_resource IS 'RFC 8707 resource indicator (optional).';
COMMENT ON COLUMN agent_contexts.oauth_cc_audience IS 'Audience claim for audience-validating ASes (optional).';
COMMENT ON COLUMN agent_contexts.oauth_cc_auth_method IS 'Client-credentials placement: basic (HTTP Basic header, RFC 6749 §2.3.1 preferred) or body (form fields). Optional; SDK default is basic.';

-- Refresh the summary view to surface client-credentials availability.
-- The view is a DB-level presentation layer for dashboards and callers
-- that want a cheap "is this agent configured?" check without fetching
-- encrypted bodies.
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
  ac.oauth_cc_token_endpoint IS NOT NULL
    AND ac.oauth_cc_client_id IS NOT NULL
    AND ac.oauth_cc_client_secret_encrypted IS NOT NULL as has_oauth_client_credentials,
  ac.tools_discovered,
  ac.last_test_scenario,
  ac.last_test_passed,
  ac.last_test_summary,
  ac.last_tested_at,
  ac.total_tests_run,
  ac.created_at,
  ac.updated_at,
  (SELECT COUNT(*) FROM agent_test_history h WHERE h.agent_context_id = ac.id) as history_count,
  (SELECT COUNT(*) FROM agent_test_history h WHERE h.agent_context_id = ac.id AND h.overall_passed) as history_passed_count
FROM agent_contexts ac;

COMMENT ON VIEW agent_context_summary IS 'Agent contexts with auth info and stats aggregated';
