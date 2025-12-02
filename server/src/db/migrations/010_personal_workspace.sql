-- Migration: Add is_personal flag to organizations
-- Personal workspaces are single-user organizations that cannot invite members

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_personal BOOLEAN DEFAULT FALSE;

-- Add index for querying personal vs team organizations
CREATE INDEX IF NOT EXISTS idx_organizations_is_personal ON organizations(is_personal);
