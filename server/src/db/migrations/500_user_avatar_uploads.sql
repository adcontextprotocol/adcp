-- Direct community profile photo uploads.
-- Generated portraits continue to live in member_portraits; this table stores
-- normalized user-uploaded avatar images used by users.avatar_url.

CREATE TABLE IF NOT EXISTS user_avatar_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id) ON DELETE CASCADE,
  image_data BYTEA NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_avatar_uploads_user
  ON user_avatar_uploads(workos_user_id, created_at DESC);
