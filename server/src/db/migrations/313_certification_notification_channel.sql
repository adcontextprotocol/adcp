-- Notification channel for certification credential awards.
-- Immediate posts for Specialist (tier 3), weekly digest for all tiers.

INSERT INTO notification_channels (name, slack_channel_id, description, is_active)
VALUES (
  'certification',
  'CERT_CHANNEL_PLACEHOLDER',
  'Credential awards and certification program updates',
  true
)
ON CONFLICT DO NOTHING;
