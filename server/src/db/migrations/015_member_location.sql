-- Add location fields to member profiles
-- headquarters: where the company is based (city, country)
-- markets: regions/markets they serve (for filtering)

ALTER TABLE member_profiles
  ADD COLUMN IF NOT EXISTS headquarters VARCHAR(255),
  ADD COLUMN IF NOT EXISTS markets TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Index for filtering by markets
CREATE INDEX IF NOT EXISTS idx_member_profiles_markets ON member_profiles USING GIN(markets);

-- Full-text search index that includes headquarters
CREATE INDEX IF NOT EXISTS idx_member_profiles_headquarters ON member_profiles(headquarters);
