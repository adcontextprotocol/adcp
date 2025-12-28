-- Migration: Replace chair/vice-chair columns with flexible leaders table
-- This allows any number of leaders per working group

-- Create the new leaders table
CREATE TABLE IF NOT EXISTS working_group_leaders (
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (working_group_id, user_id)
);

-- Create index for looking up which groups a user leads
CREATE INDEX IF NOT EXISTS idx_working_group_leaders_user_id ON working_group_leaders(user_id);

-- Migrate existing chair data
INSERT INTO working_group_leaders (working_group_id, user_id, created_at)
SELECT id, chair_user_id, NOW()
FROM working_groups
WHERE chair_user_id IS NOT NULL
ON CONFLICT (working_group_id, user_id) DO NOTHING;

-- Migrate existing vice-chair data
INSERT INTO working_group_leaders (working_group_id, user_id, created_at)
SELECT id, vice_chair_user_id, NOW()
FROM working_groups
WHERE vice_chair_user_id IS NOT NULL
ON CONFLICT (working_group_id, user_id) DO NOTHING;

-- Drop the old columns
ALTER TABLE working_groups
  DROP COLUMN IF EXISTS chair_user_id,
  DROP COLUMN IF EXISTS chair_name,
  DROP COLUMN IF EXISTS chair_title,
  DROP COLUMN IF EXISTS chair_org_name,
  DROP COLUMN IF EXISTS vice_chair_user_id,
  DROP COLUMN IF EXISTS vice_chair_name,
  DROP COLUMN IF EXISTS vice_chair_title,
  DROP COLUMN IF EXISTS vice_chair_org_name;

-- Add comments
COMMENT ON TABLE working_group_leaders IS 'Leaders of working groups - flexible number per group';
COMMENT ON COLUMN working_group_leaders.user_id IS 'WorkOS user ID of the leader';
