-- Migration: Add disqualified prospect status and reason
-- Allows filtering out orgs that should never be in outreach lists

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS disqualification_reason TEXT DEFAULT NULL;

-- Update the comment to include disqualified status
COMMENT ON COLUMN organizations.prospect_status IS 'Outreach status: prospect, contacted, responded, interested, negotiating, joined, declined, disqualified';
COMMENT ON COLUMN organizations.disqualification_reason IS 'Why this org was disqualified from outreach (e.g., "This is us", "Competitor", "Not in target market")';

-- Index for efficient filtering of disqualified orgs
CREATE INDEX IF NOT EXISTS idx_organizations_disqualified ON organizations(prospect_status) WHERE prospect_status = 'disqualified';
