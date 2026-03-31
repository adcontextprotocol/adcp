-- Ensure platform_type column exists on agent_registry_metadata.
-- Migration 331 creates the table with this column, but if the table
-- was created before 331 ran, the column may be missing.
ALTER TABLE agent_registry_metadata ADD COLUMN IF NOT EXISTS platform_type TEXT;
