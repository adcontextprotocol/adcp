-- Add encrypted auth credentials to agent_registry_metadata.
-- Publishers provide these specifically for compliance monitoring.
-- Stored encrypted at rest using the same AES-256-GCM scheme as agent_contexts.

ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS compliance_auth_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS compliance_auth_iv TEXT,
  ADD COLUMN IF NOT EXISTS compliance_auth_type TEXT DEFAULT 'bearer',
  ADD COLUMN IF NOT EXISTS compliance_auth_updated_at TIMESTAMPTZ;
