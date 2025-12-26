-- Migration: Add org_stakeholders table for account ownership tracking
-- Enables tracking primary owners and multiple interested/connected team members per org

CREATE TABLE IF NOT EXISTS org_stakeholders (
  id SERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'interested', 'connected')),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(organization_id, user_id)
);

-- Index for looking up stakeholders by org
CREATE INDEX IF NOT EXISTS idx_org_stakeholders_org ON org_stakeholders(organization_id);

-- Index for looking up all orgs a user is connected to
CREATE INDEX IF NOT EXISTS idx_org_stakeholders_user ON org_stakeholders(user_id);

-- Index for filtering by role
CREATE INDEX IF NOT EXISTS idx_org_stakeholders_role ON org_stakeholders(role);

-- Comments for clarity
COMMENT ON TABLE org_stakeholders IS 'Tracks team members responsible for or interested in each organization';
COMMENT ON COLUMN org_stakeholders.role IS 'owner = primary responsibility, interested = wants updates, connected = has relationship';
