-- Persist the latest publisher-origin adagents.json validation failure so
-- support/operator revalidation can report and audit why the cached verdict
-- was changed without requiring a separate registry edit record.

ALTER TABLE publishers
  ADD COLUMN IF NOT EXISTS last_validation_error TEXT,
  ADD COLUMN IF NOT EXISTS last_validation_issues JSONB;

COMMENT ON COLUMN publishers.last_validation_error IS
  'Short message from the latest failed publisher-origin adagents.json validation attempt. NULL after a successful validation.';

COMMENT ON COLUMN publishers.last_validation_issues IS
  'Structured errors/warnings from the latest failed publisher-origin adagents.json validation attempt. NULL after a successful validation.';
