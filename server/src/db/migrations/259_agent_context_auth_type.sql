-- Add auth_type column to agent_contexts
-- Supports 'bearer' (default, existing behavior) and 'basic' (HTTP Basic Auth)
ALTER TABLE agent_contexts ADD COLUMN auth_type VARCHAR(10) NOT NULL DEFAULT 'bearer';
