-- Migration: Drop deprecated agent_urls column
-- This column was replaced by the agents JSONB column in migration 014
-- The data was migrated to the new format, and backward compatibility is no longer needed

-- Drop the deprecated TEXT[] column
ALTER TABLE member_profiles DROP COLUMN IF EXISTS agent_urls;
