-- Add version column to adcp_state for optimistic concurrency.
--
-- @adcp/client 5.1.0 adds putIfMatch / getWithVersion / patchWithRetry on
-- AdcpStateStore. PostgresStateStore bumps this column on every put/patch
-- and uses it as the compare-and-swap token. Existing rows start at 1;
-- treat the value as opaque.
--
-- Do not attach triggers that suppress UPDATE or return OLD for this table —
-- putIfMatch relies on affected-row count to detect conflicts, and trigger-
-- suppressed writes look identical to real conflicts. Same for RLS policies.
--
-- DDL matches @adcp/client's getAdcpStateMigration().
ALTER TABLE adcp_state
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
