-- Setup Nudge Log
-- Tracks when setup nudges are sent to prevent spam
-- Used by the Addie setup-nudges job

CREATE TABLE IF NOT EXISTS setup_nudge_log (
  id SERIAL PRIMARY KEY,
  slack_user_id VARCHAR(255) NOT NULL,
  nudge_type VARCHAR(50) NOT NULL,  -- missing_logo, missing_tagline, pending_join_requests
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for efficient lookup of recent nudges per user/type
CREATE INDEX IF NOT EXISTS idx_setup_nudge_log_lookup
  ON setup_nudge_log (slack_user_id, nudge_type, sent_at DESC);
