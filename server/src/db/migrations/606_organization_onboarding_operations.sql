-- Durable exact-credential first-owner onboarding.
--
-- Provider organization and membership writes cannot share a transaction with
-- PostgreSQL. This ledger makes every provider effect recoverable by a stable
-- external ID/idempotency key and keeps the immutable credential proof that
-- authorized the eventual local commit.

CREATE TABLE organization_onboarding_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authenticated_workos_user_id VARCHAR(255) NOT NULL,
  canonical_workos_user_id VARCHAR(255) NOT NULL,
  identity_id UUID NOT NULL,
  binding_version TEXT NOT NULL,
  authorization_epoch BIGINT NOT NULL,
  credential_email VARCHAR(255) NOT NULL,
  credential_email_verified BOOLEAN NOT NULL,

  request_fingerprint CHAR(64) NOT NULL,
  client_idempotency_key VARCHAR(255),
  organization_name VARCHAR(100) NOT NULL,
  is_personal BOOLEAN NOT NULL,
  company_type VARCHAR(100),
  revenue_tier VARCHAR(100),
  marketing_opt_in BOOLEAN,
  verified_domain VARCHAR(255),
  terms_version VARCHAR(50) NOT NULL,
  privacy_version VARCHAR(50) NOT NULL,
  consent_ip VARCHAR(50),
  consent_user_agent TEXT,

  provider_idempotency_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  provider_external_id VARCHAR(255) NOT NULL UNIQUE,
  workos_organization_id VARCHAR(255),
  workos_organization_name VARCHAR(255),
  workos_membership_id VARCHAR(255),

  status VARCHAR(40) NOT NULL DEFAULT 'pending_provider_organization'
    CHECK (status IN (
      'pending_provider_organization',
      'pending_provider_membership',
      'pending_local_commit',
      'compensating',
      'completed',
      'failed',
      'manual_reconciliation'
    )),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  terminal_outcome JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK ((is_personal AND verified_domain IS NULL)
      OR (NOT is_personal AND verified_domain IS NOT NULL)),
  CHECK ((status = 'completed' AND workos_organization_id IS NOT NULL
          AND workos_membership_id IS NOT NULL AND completed_at IS NOT NULL)
      OR status <> 'completed'),
  CHECK (status NOT IN ('compensating', 'failed') OR terminal_outcome IS NOT NULL)
);

CREATE UNIQUE INDEX organization_onboarding_one_active_credential
  ON organization_onboarding_operations (authenticated_workos_user_id)
  WHERE status NOT IN ('completed', 'failed');

-- Linked credentials share org-count and personal-workspace limits. Serializing
-- by identity prevents sibling credentials from passing those checks in
-- parallel while authority remains bound to the exact credential above.
CREATE UNIQUE INDEX organization_onboarding_one_active_identity
  ON organization_onboarding_operations (identity_id)
  WHERE status NOT IN ('completed', 'failed');

CREATE UNIQUE INDEX organization_onboarding_one_active_domain
  ON organization_onboarding_operations (verified_domain)
  WHERE verified_domain IS NOT NULL AND status NOT IN ('completed', 'failed');

CREATE UNIQUE INDEX organization_onboarding_client_idempotency
  ON organization_onboarding_operations (
    authenticated_workos_user_id,
    client_idempotency_key
  )
  WHERE client_idempotency_key IS NOT NULL;

CREATE INDEX organization_onboarding_retry_lookup
  ON organization_onboarding_operations (
    authenticated_workos_user_id,
    request_fingerprint,
    created_at DESC
  );

CREATE INDEX organization_onboarding_reconciliation_queue
  ON organization_onboarding_operations (updated_at, created_at)
  WHERE status IN (
    'pending_provider_organization',
    'pending_provider_membership',
    'pending_local_commit',
    'compensating'
  );

CREATE INDEX organization_onboarding_manual_reconciliation_lookup
  ON organization_onboarding_operations (updated_at, created_at)
  WHERE status = 'manual_reconciliation';

COMMENT ON TABLE organization_onboarding_operations IS
  'Durable exact-credential first-owner operations; provider effects are reconciled by stable WorkOS external ID before local authority commits';
COMMENT ON COLUMN organization_onboarding_operations.binding_version IS
  'PostgreSQL xmin captured from the exact identity_workos_users credential binding';
COMMENT ON COLUMN organization_onboarding_operations.provider_external_id IS
  'Stable WorkOS organization external ID used to recover ambiguous create responses';
COMMENT ON COLUMN organization_onboarding_operations.terminal_outcome IS
  'Validated public failure outcome replayed after durable provider compensation';
