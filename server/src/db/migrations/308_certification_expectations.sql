-- Tracks which people a champion has invited to certify.
-- Exists independently of org membership: expectations can be created
-- before the invitee joins the org.

CREATE TABLE IF NOT EXISTS certification_expectations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_organization_id TEXT NOT NULL REFERENCES organizations(workos_organization_id),
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  workos_user_id TEXT,
  credential_target TEXT,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'joined', 'started', 'completed', 'declined')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  snooze_until TIMESTAMPTZ,
  last_resent_at TIMESTAMPTZ,
  UNIQUE(workos_organization_id, email)
);

CREATE INDEX IF NOT EXISTS idx_cert_expectations_org
  ON certification_expectations(workos_organization_id);

CREATE INDEX IF NOT EXISTS idx_cert_expectations_user
  ON certification_expectations(workos_user_id)
  WHERE workos_user_id IS NOT NULL;
