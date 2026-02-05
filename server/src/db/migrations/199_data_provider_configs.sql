-- Add data_providers column to member_profiles
-- Each data provider has: domain, is_public, signal_count (cached), categories (cached), last_validated

-- Add new JSONB column for data providers
ALTER TABLE member_profiles
ADD COLUMN IF NOT EXISTS data_providers JSONB DEFAULT '[]'::jsonb;

-- Create index for querying by data provider domain
CREATE INDEX IF NOT EXISTS idx_member_profiles_data_providers ON member_profiles USING GIN(data_providers);

-- Create index for finding public data providers
CREATE INDEX IF NOT EXISTS idx_member_profiles_public_data_providers ON member_profiles USING GIN(data_providers jsonb_path_ops);
