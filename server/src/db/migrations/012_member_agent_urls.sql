-- Add agent_urls column to member_profiles
-- Stores array of agent endpoint URLs that belong to this member
ALTER TABLE member_profiles
ADD COLUMN IF NOT EXISTS agent_urls TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Index for querying members by their agents
CREATE INDEX IF NOT EXISTS idx_member_profiles_agent_urls ON member_profiles USING GIN(agent_urls);
