-- Migration: 025_post_members_only.sql
-- Add is_members_only flag to perspectives for working group posts visibility control

ALTER TABLE perspectives
ADD COLUMN IF NOT EXISTS is_members_only BOOLEAN NOT NULL DEFAULT false;

-- Index for filtering public vs members-only posts
CREATE INDEX IF NOT EXISTS idx_perspectives_members_only ON perspectives(is_members_only);

COMMENT ON COLUMN perspectives.is_members_only IS 'When true, only working group members can view this post';
