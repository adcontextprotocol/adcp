-- Organization memberships table
-- Syncs user-organization relationships from WorkOS via webhooks
-- This enables fast local queries for user search without hitting WorkOS API

CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WorkOS identifiers
  workos_user_id VARCHAR(255) NOT NULL,
  workos_organization_id VARCHAR(255) NOT NULL,
  workos_membership_id VARCHAR(255), -- The organization_membership ID from WorkOS

  -- User details (cached from WorkOS)
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(255),
  last_name VARCHAR(255),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- Last sync from WorkOS

  -- Constraints
  UNIQUE (workos_user_id, workos_organization_id)
);

-- Indexes for search
CREATE INDEX IF NOT EXISTS idx_organization_memberships_email ON organization_memberships(email);
CREATE INDEX IF NOT EXISTS idx_organization_memberships_org_id ON organization_memberships(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_memberships_user_id ON organization_memberships(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_organization_memberships_search ON organization_memberships(
  LOWER(email), LOWER(first_name), LOWER(last_name)
);

-- Trigger for updated_at
CREATE TRIGGER update_organization_memberships_updated_at
  BEFORE UPDATE ON organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE organization_memberships IS 'Cached user-organization memberships from WorkOS for fast local queries';
COMMENT ON COLUMN organization_memberships.workos_membership_id IS 'The organization_membership resource ID from WorkOS (om_xxx)';
COMMENT ON COLUMN organization_memberships.synced_at IS 'When this record was last synced from WorkOS';
