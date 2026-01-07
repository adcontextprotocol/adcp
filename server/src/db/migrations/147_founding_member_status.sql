-- Add founding member status to member_profiles
-- Founding members are corporate members who joined before April 1, 2026

-- Add founding member column
ALTER TABLE member_profiles
ADD COLUMN IF NOT EXISTS is_founding_member BOOLEAN DEFAULT FALSE;

-- Create index for founding member queries
CREATE INDEX IF NOT EXISTS idx_member_profiles_founding
ON member_profiles(is_founding_member)
WHERE is_founding_member = TRUE;

-- Set founding member status for existing members
-- All members created before the cutoff date are founding members
UPDATE member_profiles
SET is_founding_member = TRUE
WHERE created_at < '2026-04-01'::timestamptz;
