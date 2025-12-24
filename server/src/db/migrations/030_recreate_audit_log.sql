-- Recreate registry_audit_log table
-- This was dropped in 023_drop_registry_tables.sql but is still used for organization audit logging

CREATE TABLE IF NOT EXISTS registry_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workos_organization_id VARCHAR(255) NOT NULL,
    workos_user_id VARCHAR(255) NOT NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_organization ON registry_audit_log(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON registry_audit_log(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON registry_audit_log(created_at);
