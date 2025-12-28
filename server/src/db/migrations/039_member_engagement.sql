-- Migration: 039_member_engagement.sql
-- Add interest level fields for human-set engagement assessment
-- Login tracking uses existing org_activities table with activity_type = 'dashboard_login'

-- Add interest level fields to organizations
-- Human-set interest level with attribution (e.g., "high (as of 11/30/25 per Brian)")
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level VARCHAR(50);  -- low, medium, high, very_high
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level_note TEXT;  -- Free text note about the interest level
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level_set_by VARCHAR(255);  -- Name of person who set it
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS interest_level_set_at TIMESTAMP WITH TIME ZONE;

-- Index for filtering by activity type (useful for counting logins)
CREATE INDEX IF NOT EXISTS idx_org_activities_type ON org_activities(activity_type);

-- Comments
COMMENT ON COLUMN organizations.interest_level IS 'Human-set interest level: low, medium, high, very_high';
COMMENT ON COLUMN organizations.interest_level_note IS 'Free text note about the interest level assessment';
COMMENT ON COLUMN organizations.interest_level_set_by IS 'Name of the person who set the interest level';
COMMENT ON COLUMN organizations.interest_level_set_at IS 'When the interest level was last set';
