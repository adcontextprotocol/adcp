-- Seat types: contributor vs community-only
-- Contributors get Slack, working groups, councils, product summit.
-- Community-only get Addie, certification, training, chapters.

ALTER TABLE organization_memberships
ADD COLUMN IF NOT EXISTS seat_type VARCHAR(20) NOT NULL DEFAULT 'contributor'
  CHECK (seat_type IN ('contributor', 'community_only'));

CREATE INDEX IF NOT EXISTS idx_organization_memberships_seat_type
  ON organization_memberships(workos_organization_id, seat_type);

COMMENT ON COLUMN organization_memberships.seat_type IS
  'contributor = full access (Slack, working groups, councils, summit); community_only = Addie, certification, training, chapters';
