-- Drop registry tables
-- Agent management has been migrated to member_profiles.agents JSONB array

-- Drop audit log first (has FK to registry_entries)
DROP TABLE IF EXISTS registry_audit_log;

-- Drop main registry table
DROP TABLE IF EXISTS registry_entries;
