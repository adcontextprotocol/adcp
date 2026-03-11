-- Index for admin dashboard queries that filter by status and started_at
-- (abandonment detection, stuck learner queries)
CREATE INDEX IF NOT EXISTS idx_learner_progress_status_started
  ON learner_progress(status, started_at);
