-- Member Portraits
-- Illustrated character portraits for AAO members, generated via Gemini.

CREATE TABLE IF NOT EXISTS member_portraits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_profile_id UUID NOT NULL REFERENCES member_profiles(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  portrait_data BYTEA,
  prompt_used TEXT,
  vibe TEXT,
  palette TEXT NOT NULL DEFAULT 'amber',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'approved', 'rejected')),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_member_portraits_profile
  ON member_portraits(member_profile_id);
CREATE INDEX IF NOT EXISTS idx_member_portraits_status
  ON member_portraits(status);

CREATE TRIGGER update_member_portraits_updated_at
  BEFORE UPDATE ON member_portraits
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Active portrait pointer on member_profiles
ALTER TABLE member_profiles
  ADD COLUMN IF NOT EXISTS portrait_id UUID REFERENCES member_portraits(id);
