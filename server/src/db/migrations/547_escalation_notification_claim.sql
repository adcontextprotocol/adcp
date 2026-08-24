-- Separate an in-flight notification claim from confirmed Slack delivery.
-- notification_sent_at drives the admin UI's "Team notified" badge and must
-- remain NULL until Slack has accepted the message.

ALTER TABLE addie_escalations
  ADD COLUMN notification_claimed_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN addie_escalations.notification_claimed_at IS
  'Short-lived claim used to serialize initial Slack notification delivery; cleared after delivery or a definite send failure.';
