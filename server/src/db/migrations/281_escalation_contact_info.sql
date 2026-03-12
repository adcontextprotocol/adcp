-- Add contact info fields to escalations
-- Ensures admins can always reach users who escalate, even when their
-- Slack is not linked to an AgenticAdvertising.org account.

ALTER TABLE addie_escalations
  ADD COLUMN user_email TEXT,
  ADD COLUMN user_slack_handle TEXT;

CREATE INDEX idx_escalations_workos_user ON addie_escalations(workos_user_id)
  WHERE workos_user_id IS NOT NULL;
