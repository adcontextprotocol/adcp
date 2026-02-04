-- Migration: 198_oauth_redirect_uri_tracking.sql
-- Track the redirect_uri used during OAuth client registration
--
-- This enables automatic recovery when redirect_uri changes (e.g., environment change)
-- by detecting mismatches and re-registering the OAuth client.

ALTER TABLE agent_contexts
ADD COLUMN IF NOT EXISTS oauth_registered_redirect_uri TEXT;

COMMENT ON COLUMN agent_contexts.oauth_registered_redirect_uri IS 'The redirect_uri used when registering the OAuth client - used to detect mismatches';
