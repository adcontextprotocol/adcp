-- Community members may propose catalog-only mirrors, but only registry
-- moderators or AgenticAdvertising.org administrators publish them. Keep the
-- proposed document separate from community_mirrors so unreviewed catalog
-- data can never leak into the public serving or publisher projection paths.
CREATE TABLE IF NOT EXISTS community_mirror_proposals (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform                    TEXT NOT NULL CHECK (platform ~ '^[a-z0-9_-]{1,64}$'),
  adagents_json               JSONB NOT NULL,
  catalog_etag                TEXT,
  superseded_by               TEXT,
  proposal_digest             TEXT NOT NULL CHECK (proposal_digest ~ '^[a-f0-9]{64}$'),
  base_mirror_digest          TEXT CHECK (base_mirror_digest IS NULL OR base_mirror_digest ~ '^[a-f0-9]{64}$'),
  status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by_user_id         TEXT NOT NULL,
  proposed_by_email           TEXT,
  proposed_by_organization_id TEXT,
  proposed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by_user_id         TEXT,
  reviewed_at                 TIMESTAMPTZ,
  review_notes                TEXT,
  published_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_mirror_proposals_review_queue
  ON community_mirror_proposals (status, proposed_at DESC);

-- Re-running a submission script updates that caller's pending proposal
-- rather than filling the moderation queue with duplicates. Historical
-- approved/rejected proposals remain append-only review records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_mirror_proposals_pending_org
  ON community_mirror_proposals (platform, proposed_by_organization_id)
  WHERE status = 'pending' AND proposed_by_organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_mirror_proposals_pending_user
  ON community_mirror_proposals (platform, proposed_by_user_id)
  WHERE status = 'pending' AND proposed_by_organization_id IS NULL;

DROP TRIGGER IF EXISTS update_community_mirror_proposals_updated_at
  ON community_mirror_proposals;
CREATE TRIGGER update_community_mirror_proposals_updated_at
  BEFORE UPDATE ON community_mirror_proposals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE community_mirror_proposals IS
  'Authenticated community submissions awaiting moderator review before publication as community mirrors';
