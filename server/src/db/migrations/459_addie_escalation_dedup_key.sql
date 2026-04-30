-- Add dedup_key to addie_escalations for operational escalations
-- (e.g., Slack 'not_in_channel' for channel X) so we don't create a new
-- escalation for every occurrence. The partial unique index lets the
-- same key be used again once the prior escalation is resolved/closed.

ALTER TABLE addie_escalations
  ADD COLUMN dedup_key TEXT;

CREATE UNIQUE INDEX idx_escalations_dedup_open
  ON addie_escalations (dedup_key)
  WHERE dedup_key IS NOT NULL
    AND status IN ('open', 'acknowledged', 'in_progress');
