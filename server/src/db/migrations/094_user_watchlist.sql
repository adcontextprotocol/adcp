-- Migration: User watchlist table
-- Saved articles for logged-in users (Watch tab functionality)

CREATE TABLE IF NOT EXISTS user_watchlist (
  id SERIAL PRIMARY KEY,
  workos_user_id VARCHAR(255) NOT NULL REFERENCES users(workos_user_id) ON DELETE CASCADE,
  knowledge_id INTEGER NOT NULL REFERENCES addie_knowledge(id) ON DELETE CASCADE,

  -- Optional notes from user
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Each user can only save an article once
  UNIQUE(workos_user_id, knowledge_id)
);

-- Index for listing user's saved articles (most recent first)
CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist(workos_user_id, created_at DESC);

-- Index for checking if an article is saved by any user
CREATE INDEX IF NOT EXISTS idx_user_watchlist_article ON user_watchlist(knowledge_id);

COMMENT ON TABLE user_watchlist IS 'User-saved articles for the Watch tab in The Latest';
