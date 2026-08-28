-- Migration 562: authoritative seller-side governance-agent bindings. Each principal/account
-- has one atomic row addressable by either seller account_id or the complete
-- canonical natural identity. Credentials are encrypted separately from the
-- non-secret agent descriptor so they never appear in binding JSON.
CREATE TABLE IF NOT EXISTS governance_agent_bindings (
  principal_scope TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  brand_domain TEXT NOT NULL,
  account_ref JSONB NOT NULL,
  agents JSONB NOT NULL,
  credentials_encrypted TEXT NOT NULL,
  credentials_iv TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (principal_scope, account_id),
  CONSTRAINT governance_agent_bindings_principal_nonempty CHECK (length(principal_scope) > 0),
  CONSTRAINT governance_agent_bindings_account_id_nonempty CHECK (length(account_id) > 0),
  CONSTRAINT governance_agent_bindings_account_scope_nonempty CHECK (length(account_scope) > 0),
  CONSTRAINT governance_agent_bindings_brand_domain_nonempty CHECK (length(brand_domain) > 0),
  CONSTRAINT governance_agent_bindings_account_ref_object CHECK (jsonb_typeof(account_ref) = 'object'),
  CONSTRAINT governance_agent_bindings_agents_singleton CHECK (
    jsonb_typeof(agents) = 'array' AND jsonb_array_length(agents) = 1
  ),
  CONSTRAINT governance_agent_bindings_credentials_nonempty CHECK (
    length(credentials_encrypted) > 0 AND length(credentials_iv) > 0
  ),
  CONSTRAINT governance_agent_bindings_principal_scope_unique
    UNIQUE (principal_scope, account_scope)
);

CREATE INDEX IF NOT EXISTS idx_governance_agent_bindings_principal_brand
  ON governance_agent_bindings (principal_scope, brand_domain, account_id);

COMMENT ON COLUMN governance_agent_bindings.credentials_encrypted IS
  'AES-256-GCM encrypted governance-agent Bearer credential';

-- SDK 14's durable decisioning task registry records owner_scope on every
-- create and uses it with account_id for tenant/principal-isolated polling.
-- Migration 463 predates that column; keep it nullable for its legacy rows,
-- matching the SDK's current upgrade DDL and fallback semantics.
ALTER TABLE adcp_decisioning_tasks
  ADD COLUMN IF NOT EXISTS owner_scope TEXT;

CREATE INDEX IF NOT EXISTS idx_adcp_decisioning_tasks_owner_account
  ON adcp_decisioning_tasks (owner_scope, account_id);
