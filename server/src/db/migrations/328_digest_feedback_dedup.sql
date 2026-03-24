-- Prevent duplicate feedback votes per tracking ID
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_feedback_unique_tracker
  ON digest_feedback (edition_date, tracking_id) WHERE tracking_id IS NOT NULL;
