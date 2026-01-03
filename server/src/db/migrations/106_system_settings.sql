-- System settings for configurable application behavior
-- Stores key-value settings like Slack channel IDs for various notification types

CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by VARCHAR(255)  -- workos_user_id of admin who last updated
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_system_settings_updated_at ON system_settings(updated_at);

-- Insert default settings
INSERT INTO system_settings (key, value, description) VALUES
  ('billing_slack_channel', '{"channel_id": null, "channel_name": null}', 'Slack channel for billing notifications (payments, invoices, subscriptions)')
ON CONFLICT (key) DO NOTHING;

-- Comments for documentation
COMMENT ON TABLE system_settings IS 'Key-value store for system-wide configuration settings';
COMMENT ON COLUMN system_settings.key IS 'Unique setting identifier';
COMMENT ON COLUMN system_settings.value IS 'JSON value for the setting';
COMMENT ON COLUMN system_settings.description IS 'Human-readable description of what this setting controls';
