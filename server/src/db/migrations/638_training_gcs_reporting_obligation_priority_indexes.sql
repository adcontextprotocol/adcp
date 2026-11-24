-- REPORTING_LEDGER_MIGRATION obligation claim indexes that migration 620 did
-- not carry. The SDK's ledger SQL has defined both since before reporting-storage
-- 0.3.0-beta.1: the obligation claim orders live work before history backfill,
-- and these partial indexes serve that order (globally and per account)
-- without sorting the pending backlog. The statements are verbatim from the
-- SDK and idempotent. The migration runner applies every file inside one
-- transaction, so CREATE INDEX CONCURRENTLY is not available. The first build
-- takes a SHARE lock on adcp_reporting_obligations and the transaction holds it
-- across both builds until COMMIT: writes to the table (not reads) wait until
-- the migration commits. lock_timeout bounds the wait for that lock, and
-- statement_timeout bounds each CREATE INDEX separately.
DO $schema_precondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'training_reporting_gcs') THEN
    RAISE EXCEPTION 'Provision training_reporting_gcs for the application role before migration 638';
  END IF;
  IF NOT has_schema_privilege(current_user, 'training_reporting_gcs', 'USAGE')
    OR NOT has_schema_privilege(current_user, 'training_reporting_gcs', 'CREATE') THEN
    RAISE EXCEPTION 'Application role requires USAGE and CREATE on training_reporting_gcs';
  END IF;
END;
$schema_precondition$;
SET LOCAL search_path = training_reporting_gcs, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $table_precondition$
BEGIN
  IF to_regclass('adcp_reporting_obligations') IS NULL THEN
    RAISE EXCEPTION 'Apply training GCS reporting migration 620 before migration 638';
  END IF;
END;
$table_precondition$;

-- Match live-first claims without sorting the entire pending history backlog.
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_priority_due
  ON adcp_reporting_obligations ((COALESCE(data->>'history', 'false') = 'true'), next_attempt_at, obligation_id)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_account_priority_due
  ON adcp_reporting_obligations (account_id, (COALESCE(data->>'history', 'false') = 'true'), next_attempt_at, obligation_id)
  WHERE state = 'pending';
