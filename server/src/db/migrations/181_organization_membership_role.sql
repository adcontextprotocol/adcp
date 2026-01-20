-- Add role column to organization_memberships table
-- Caches the role from WorkOS for display without requiring API calls

ALTER TABLE organization_memberships
ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'member';

-- Create index for role-based queries
CREATE INDEX IF NOT EXISTS idx_organization_memberships_role ON organization_memberships(role);
