-- Task reminder log
-- Tracks when task reminders were sent to prevent spam

CREATE TABLE IF NOT EXISTS task_reminder_log (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for checking if reminder was already sent today
CREATE INDEX IF NOT EXISTS idx_task_reminder_log_user_date
  ON task_reminder_log(user_id, sent_at);

-- Keep log entries for 30 days, then they can be cleaned up
COMMENT ON TABLE task_reminder_log IS 'Log of task reminder DMs sent to prevent duplicate daily reminders';
