-- Authorization-server provenance is independent for client registration and
-- issued tokens. Historical grants have no trustworthy issuer to infer here.
ALTER TABLE agent_contexts
  ADD COLUMN IF NOT EXISTS oauth_token_issuer TEXT,
  ADD COLUMN IF NOT EXISTS oauth_client_issuer TEXT;

COMMENT ON COLUMN agent_contexts.oauth_token_issuer IS
  'Validated authorization-server issuer for the saved OAuth tokens; NULL requires owner reauthorization before refresh';
COMMENT ON COLUMN agent_contexts.oauth_client_issuer IS
  'Validated authorization-server issuer for the saved OAuth client registration; NULL must not be inferred from current discovery';
