-- reporting-storage 0.3.0-beta.1 writes history_start on every configuration
-- installation, including configurations without a historical start override.
-- NULL preserves the existing installed-at history boundary.
SET LOCAL search_path = training_reporting_gcs, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $history_start$
DECLARE
  configurations regclass := to_regclass('adcp_reporting_configurations');
BEGIN
  IF configurations IS NULL THEN
    RAISE EXCEPTION 'Apply training GCS reporting migration 620 before migration 630';
  END IF;
  -- Avoid taking ACCESS EXCLUSIVE on a replay when the column already exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = configurations AND attname = 'history_start' AND NOT attisdropped
  ) THEN
    ALTER TABLE adcp_reporting_configurations ADD COLUMN history_start TIMESTAMPTZ;
  END IF;
END
$history_start$;
