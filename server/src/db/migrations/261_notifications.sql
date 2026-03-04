-- Notification infrastructure for in-app and Slack DM notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  type TEXT NOT NULL,
  reference_id TEXT,
  reference_type TEXT,
  title TEXT NOT NULL,
  url TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_cleanup
  ON notifications(created_at);

COMMENT ON TABLE notifications IS 'In-app notifications for user activity (connections, group joins, events, badges)';
