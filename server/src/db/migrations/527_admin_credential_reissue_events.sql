-- Append-only provenance for admin-triggered Certifier credential recovery.

ALTER TABLE user_credentials
  ADD COLUMN IF NOT EXISTS certifier_issuance_key UUID,
  ADD COLUMN IF NOT EXISTS certifier_issuance_state TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS certifier_delivery_state TEXT NOT NULL DEFAULT 'not_started';

ALTER TABLE user_credentials
  DROP CONSTRAINT IF EXISTS user_credentials_certifier_issuance_state_check,
  ADD CONSTRAINT user_credentials_certifier_issuance_state_check
    CHECK (certifier_issuance_state IN (
      'not_started', 'creating', 'draft_created', 'issuing', 'issued', 'complete', 'reconcile_required'
    )),
  DROP CONSTRAINT IF EXISTS user_credentials_certifier_delivery_state_check,
  ADD CONSTRAINT user_credentials_certifier_delivery_state_check
    CHECK (certifier_delivery_state IN ('not_started', 'sending', 'sent', 'unknown'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_credentials_certifier_issuance_key
  ON user_credentials(certifier_issuance_key)
  WHERE certifier_issuance_key IS NOT NULL;

UPDATE user_credentials
SET certifier_issuance_state = 'issued',
    certifier_delivery_state = 'unknown'
WHERE certifier_credential_id IS NOT NULL
  AND certifier_issuance_state = 'not_started';

CREATE TABLE IF NOT EXISTS admin_credential_reissue_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  credential_id VARCHAR(50) NOT NULL REFERENCES certification_credentials(id),
  admin_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('started', 'succeeded', 'failed')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_credential_reissue_events_operation
  ON admin_credential_reissue_events(operation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_credential_reissue_events_target
  ON admin_credential_reissue_events(workos_user_id, credential_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_credential_reissue_events_admin
  ON admin_credential_reissue_events(admin_user_id, created_at DESC);

COMMENT ON TABLE admin_credential_reissue_events IS
  'Append-only audit events for admin-triggered Certifier credential recovery.';
