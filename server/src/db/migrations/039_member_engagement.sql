-- Migration: 039_member_engagement.sql
-- Comprehensive member engagement tracking
-- Tracks both automated signals and human-set interest levels

-- User login tracking table
-- Records dashboard logins per user for engagement metrics
CREATE TABLE IF NOT EXISTS user_logins (
  id SERIAL PRIMARY KEY,

  -- Who logged in
  workos_user_id VARCHAR(255) NOT NULL,
  workos_organization_id VARCHAR(255),  -- May be null for personal workspaces

  -- Login details
  logged_in_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address VARCHAR(50),
  user_agent TEXT
);

-- Indexes for user logins
CREATE INDEX IF NOT EXISTS idx_user_logins_user ON user_logins(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_user_logins_org ON user_logins(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_user_logins_time ON user_logins(logged_in_at DESC);

-- Add interest level fields to organizations
-- Human-set interest level with attribution (e.g., "high (as of 11/30/25 per Brian)")
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level VARCHAR(50);  -- low, medium, high, very_high
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level_note TEXT;  -- Free text note about the interest level
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level_set_by VARCHAR(255);  -- Name of person who set it
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level_set_at TIMESTAMP WITH TIME ZONE;

-- Comments
COMMENT ON TABLE user_logins IS 'Tracks user dashboard logins for engagement analytics';
COMMENT ON COLUMN user_logins.workos_organization_id IS 'Organization context of the login (if any)';

COMMENT ON COLUMN organizations.interest_level IS 'Human-set interest level: low, medium, high, very_high';
COMMENT ON COLUMN organizations.interest_level_note IS 'Free text note about the interest level assessment';
COMMENT ON COLUMN organizations.interest_level_set_by IS 'Name of the person who set the interest level';
COMMENT ON COLUMN organizations.interest_level_set_at IS 'When the interest level was last set';
