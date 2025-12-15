-- Migration: 020_perspective_likes.sql
-- Likes/reactions for perspectives content

-- Likes table for tracking article engagement
CREATE TABLE IF NOT EXISTS perspective_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perspective_id UUID NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,

  -- Anonymous likes use fingerprint, authenticated users use user_id
  -- Only one of these should be set per like
  fingerprint VARCHAR(64),  -- Browser fingerprint hash for anonymous users
  user_id UUID,             -- For future authenticated users

  -- Track IP for rate limiting (hashed for privacy)
  ip_hash VARCHAR(64),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Ensure one like per perspective per fingerprint/user
  CONSTRAINT unique_perspective_fingerprint UNIQUE (perspective_id, fingerprint),
  CONSTRAINT unique_perspective_user UNIQUE (perspective_id, user_id)
);

-- Add like_count column to perspectives for fast reads
ALTER TABLE perspectives
  ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0;

-- Index for counting likes per perspective
CREATE INDEX IF NOT EXISTS idx_perspective_likes_perspective_id
  ON perspective_likes(perspective_id);

-- Index for rate limiting by IP
CREATE INDEX IF NOT EXISTS idx_perspective_likes_ip_hash
  ON perspective_likes(ip_hash, created_at);

-- Function to update like count on perspectives table
CREATE OR REPLACE FUNCTION update_perspective_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE perspectives
    SET like_count = like_count + 1
    WHERE id = NEW.perspective_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE perspectives
    SET like_count = like_count - 1
    WHERE id = OLD.perspective_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update like counts
DROP TRIGGER IF EXISTS trigger_update_perspective_like_count ON perspective_likes;
CREATE TRIGGER trigger_update_perspective_like_count
  AFTER INSERT OR DELETE ON perspective_likes
  FOR EACH ROW
  EXECUTE FUNCTION update_perspective_like_count();

-- Comments for documentation
COMMENT ON TABLE perspective_likes IS 'Tracks likes/reactions on perspectives for engagement metrics';
COMMENT ON COLUMN perspective_likes.fingerprint IS 'Browser fingerprint hash for anonymous like tracking';
COMMENT ON COLUMN perspective_likes.ip_hash IS 'Hashed IP address for rate limiting';
COMMENT ON COLUMN perspectives.like_count IS 'Denormalized count of likes for fast reads';
