-- Migration: Add prospect tracking fields to organizations table
-- This enables tracking outreach status for companies before they sign up

-- Prospect status enum values:
-- 'prospect' - Not contacted yet
-- 'contacted' - Outreach sent
-- 'responded' - They replied
-- 'interested' - Expressed interest
-- 'negotiating' - In discussions
-- 'joined' - Converted to member (has users)
-- 'declined' - Not interested

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS prospect_status VARCHAR(50) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_source VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_notes TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_contact_name VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_contact_email VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_contact_title VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_next_action TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_next_action_date DATE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_owner VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS parent_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE SET NULL;

-- Index for filtering by prospect status
CREATE INDEX IF NOT EXISTS idx_organizations_prospect_status ON organizations(prospect_status);

-- Index for parent/subsidiary lookups
CREATE INDEX IF NOT EXISTS idx_organizations_parent ON organizations(parent_organization_id);

-- Index for filtering by owner
CREATE INDEX IF NOT EXISTS idx_organizations_prospect_owner ON organizations(prospect_owner);

-- Add comment explaining the prospect workflow
COMMENT ON COLUMN organizations.prospect_status IS 'Outreach status: prospect, contacted, responded, interested, negotiating, joined, declined';
COMMENT ON COLUMN organizations.prospect_source IS 'How we found them: aao_launch_list, referral, inbound, slack, etc.';
COMMENT ON COLUMN organizations.prospect_owner IS 'Who owns this relationship: Brian, Randy, Matt, etc.';
COMMENT ON COLUMN organizations.parent_organization_id IS 'Parent org for subsidiary relationships (e.g., Dow Jones parent is News Corp)';
