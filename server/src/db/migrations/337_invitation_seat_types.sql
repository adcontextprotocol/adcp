-- Transient table bridging invite-time seat_type intent to acceptance-time webhook.
-- Rows are consumed atomically via DELETE ... RETURNING when the membership webhook fires.

CREATE TABLE IF NOT EXISTS invitation_seat_types (
  workos_invitation_id TEXT PRIMARY KEY,
  workos_organization_id TEXT NOT NULL,
  email TEXT NOT NULL,
  seat_type VARCHAR(20) NOT NULL DEFAULT 'contributor'
    CHECK (seat_type IN ('contributor', 'community_only')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invitation_seat_types_org_email
  ON invitation_seat_types (workos_organization_id, lower(email));
