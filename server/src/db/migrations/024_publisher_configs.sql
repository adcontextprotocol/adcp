-- Add publishers column to member_profiles
-- Each publisher has: domain, is_public, agent_count (cached), last_validated

-- Add new JSONB column for publishers
ALTER TABLE member_profiles
ADD COLUMN IF NOT EXISTS publishers JSONB DEFAULT '[]'::jsonb;

-- Create index for querying by publisher domain
CREATE INDEX IF NOT EXISTS idx_member_profiles_publishers ON member_profiles USING GIN(publishers);

-- Create index for finding public publishers
CREATE INDEX IF NOT EXISTS idx_member_profiles_public_publishers ON member_profiles USING GIN(publishers jsonb_path_ops);
