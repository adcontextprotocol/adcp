-- Convert agent_urls from TEXT[] to JSONB for richer agent configuration
-- Each agent can now have: url, is_public, name (cached), type

-- Step 1: Add new JSONB column
ALTER TABLE member_profiles
ADD COLUMN IF NOT EXISTS agents JSONB DEFAULT '[]'::jsonb;

-- Step 2: Migrate existing agent_urls to new format
-- Each URL becomes an object with is_public defaulting to true (existing agents are public)
UPDATE member_profiles
SET agents = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'url', url,
        'is_public', true
      )
    ),
    '[]'::jsonb
  )
  FROM unnest(agent_urls) AS url
)
WHERE agent_urls IS NOT NULL AND array_length(agent_urls, 1) > 0;

-- Step 3: Drop the old column (after migration is verified)
-- We'll keep agent_urls for now and generate it from agents for backward compatibility
-- This can be cleaned up in a future migration

-- Create index for querying by agent URL
CREATE INDEX IF NOT EXISTS idx_member_profiles_agents ON member_profiles USING GIN(agents);

-- Create index for finding public agents
CREATE INDEX IF NOT EXISTS idx_member_profiles_public_agents ON member_profiles USING GIN(agents jsonb_path_ops);
