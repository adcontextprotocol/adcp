-- SDK 15.8.1 REPORTING_LEDGER_MIGRATION delta over the 15.2.0 SQL in migration 620.
-- PostgresReportingLedgerStore.putObligation and the producer's retired-period
-- read query this table unconditionally, so the GCS reporting runtime needs it
-- even with retention disabled. Additive and idempotent in the same schema.
DO $schema_precondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'training_reporting_gcs') THEN
    RAISE EXCEPTION 'Provision training_reporting_gcs for the application role before migration 621';
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

-- A retired period keeps one compact record: it refuses replays that would
-- resurrect the period and preserves the audit conclusion after the period's
-- ledger records are deleted.
CREATE TABLE IF NOT EXISTS adcp_reporting_obligation_tombstones (
  obligation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  period_ordinal BIGINT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('retiring', 'retired')),
  final_revision_id TEXT,
  final_content_sha256 TEXT,
  revision_count INTEGER NOT NULL CHECK (revision_count >= 0),
  adjustment_count INTEGER NOT NULL CHECK (adjustment_count >= 0),
  retiring_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  UNIQUE (configuration_id, period_ordinal),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_obligation_tombstones_account
  ON adcp_reporting_obligation_tombstones (account_id, configuration_id, period_ordinal);
