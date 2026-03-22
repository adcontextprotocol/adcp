-- Organization-level certification goals.
-- Admins set targets like "5 Practitioners by Q2".

CREATE TABLE IF NOT EXISTS certification_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_organization_id TEXT NOT NULL REFERENCES organizations(workos_organization_id),
  credential_id TEXT NOT NULL REFERENCES certification_credentials(id),
  target_count INTEGER NOT NULL CHECK (target_count > 0),
  deadline DATE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workos_organization_id, credential_id)
);
