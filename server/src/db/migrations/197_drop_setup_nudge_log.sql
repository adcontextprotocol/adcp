-- Drop setup_nudge_log table
-- The setup nudges feature has been removed in favor of the proactive outreach system.
-- This table is no longer used.

DROP INDEX IF EXISTS idx_setup_nudge_log_lookup;
DROP TABLE IF EXISTS setup_nudge_log;
