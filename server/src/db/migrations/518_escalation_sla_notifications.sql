-- SLA notification state for Addie escalations. Keep this out of
-- addie_escalations so job-only notification bookkeeping does not trip the
-- escalation table's generic updated_at trigger and reset the human-progress
-- SLA clock.

CREATE TABLE IF NOT EXISTS addie_escalation_sla_notifications (
  escalation_id INTEGER PRIMARY KEY REFERENCES addie_escalations(id) ON DELETE CASCADE,
  admin_last_notified_at TIMESTAMPTZ,
  requester_last_notified_at TIMESTAMPTZ,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_addie_escalation_sla_notifications_updated_at
  BEFORE UPDATE ON addie_escalation_sla_notifications
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_addie_escalations_active_sla_notifications
  ON addie_escalations(status, priority, created_at, updated_at)
  WHERE status IN ('open', 'acknowledged', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_addie_escalation_sla_notifications_cooldowns
  ON addie_escalation_sla_notifications(admin_last_notified_at, requester_last_notified_at);
