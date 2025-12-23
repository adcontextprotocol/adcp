-- Migration: 024_working_groups.sql
-- Working Groups feature for AAO member collaboration
-- Users (not organizations) join working groups
-- Organizations show banner if any of their users are members

-- Working Groups Table
CREATE TABLE IF NOT EXISTS working_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,  -- Markdown homepage content

  -- Slack integration
  slack_channel_url TEXT,

  -- Leadership (individual users, not organizations)
  chair_user_id VARCHAR(255),  -- WorkOS user ID
  chair_name VARCHAR(255),
  chair_title VARCHAR(255),
  chair_org_name VARCHAR(255),

  vice_chair_user_id VARCHAR(255),
  vice_chair_name VARCHAR(255),
  vice_chair_title VARCHAR(255),
  vice_chair_org_name VARCHAR(255),

  -- Access control
  is_private BOOLEAN NOT NULL DEFAULT false,  -- Private = invite-only by admin

  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'archived')),

  -- Display settings
  display_order INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for working_groups
CREATE INDEX IF NOT EXISTS idx_working_groups_slug ON working_groups(slug);
CREATE INDEX IF NOT EXISTS idx_working_groups_status ON working_groups(status);
CREATE INDEX IF NOT EXISTS idx_working_groups_private ON working_groups(is_private);
CREATE INDEX IF NOT EXISTS idx_working_groups_order ON working_groups(display_order, name);

-- Trigger for updated_at
CREATE TRIGGER update_working_groups_updated_at
  BEFORE UPDATE ON working_groups
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE working_groups IS 'Working groups for AAO member collaboration';
COMMENT ON COLUMN working_groups.chair_user_id IS 'WorkOS user ID of the chair (individual, not organization)';
COMMENT ON COLUMN working_groups.is_private IS 'Private groups are invite-only by admin (e.g., Board, Advisory Council)';
COMMENT ON COLUMN working_groups.display_order IS 'Lower numbers appear first in listings';


-- Working Group Memberships Table (individual users)
CREATE TABLE IF NOT EXISTS working_group_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which working group
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- Which user is a member (individual, not organization)
  workos_user_id VARCHAR(255) NOT NULL,
  user_email VARCHAR(255),
  user_name VARCHAR(255),  -- Cached for display
  user_org_name VARCHAR(255),  -- Cached org name for display

  -- Link to organization for banner lookup on member profiles
  workos_organization_id VARCHAR(255),

  -- Membership status
  status VARCHAR(50) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),

  -- Who added them (admin user ID or self)
  added_by_user_id VARCHAR(255),

  -- Timestamps
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Unique constraint: one membership per user per working group
CREATE UNIQUE INDEX IF NOT EXISTS idx_wg_membership_unique
  ON working_group_memberships(working_group_id, workos_user_id);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_wg_membership_group ON working_group_memberships(working_group_id);
CREATE INDEX IF NOT EXISTS idx_wg_membership_user ON working_group_memberships(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_wg_membership_org ON working_group_memberships(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_wg_membership_status ON working_group_memberships(status);

-- Trigger for updated_at
CREATE TRIGGER update_wg_memberships_updated_at
  BEFORE UPDATE ON working_group_memberships
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE working_group_memberships IS 'Individual user memberships in working groups';
COMMENT ON COLUMN working_group_memberships.workos_organization_id IS 'Used for showing working group banner on org member profiles';


-- Extend perspectives table for working group posts
-- When working_group_id is set, the perspective is a working group post (notes, minutes, links)
ALTER TABLE perspectives
ADD COLUMN IF NOT EXISTS working_group_id UUID REFERENCES working_groups(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS author_user_id VARCHAR(255);

-- Index for filtering perspectives by working group
CREATE INDEX IF NOT EXISTS idx_perspectives_working_group ON perspectives(working_group_id);
CREATE INDEX IF NOT EXISTS idx_perspectives_author_user ON perspectives(author_user_id);

-- Comments
COMMENT ON COLUMN perspectives.working_group_id IS 'When set, this perspective is a working group post';
COMMENT ON COLUMN perspectives.author_user_id IS 'WorkOS user ID of the author, for permission checks';


-- Seed initial private working groups
INSERT INTO working_groups (name, slug, description, is_private, display_order, status)
VALUES
  ('Board of Directors', 'board', 'The AAO Board of Directors oversees organizational governance and strategic direction.', true, 1, 'active'),
  ('AAO Administration', 'aao-admin', 'Administrative team managing day-to-day AAO operations.', true, 2, 'active'),
  ('Advisory Council', 'advisory-council', 'Industry advisors providing strategic guidance to the AAO.', true, 3, 'active'),
  ('Technical Steering Committee', 'technical-steering', 'Technical leadership guiding AdCP protocol development and standards.', true, 4, 'active')
ON CONFLICT (slug) DO NOTHING;
