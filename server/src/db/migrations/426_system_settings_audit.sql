-- Audit history for system_settings changes
-- Records every setSetting call with old/new values and the acting admin

CREATE TABLE IF NOT EXISTS system_settings_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  changed_by VARCHAR(255),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_settings_audit_key ON system_settings_audit(key);
CREATE INDEX IF NOT EXISTS idx_system_settings_audit_changed_by ON system_settings_audit(changed_by);
CREATE INDEX IF NOT EXISTS idx_system_settings_audit_changed_at ON system_settings_audit(changed_at DESC);

COMMENT ON TABLE system_settings_audit IS 'Append-only history of every system_settings change';
COMMENT ON COLUMN system_settings_audit.old_value IS 'Value before the change; NULL for newly created keys';
COMMENT ON COLUMN system_settings_audit.changed_by IS 'WorkOS user ID of the admin who made the change';
