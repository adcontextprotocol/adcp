-- reporting-storage 0.3.0-beta.9 (with @adcp/sdk 17.0.0-beta.40) migration
-- deltas over the SQL in migrations 620, 621, 624 and 630. Principal-level
-- reporting subscriptions (AdCP 3.3) add subscription_key to Core configurations
-- and widen their uniqueness to include it; the store writes the column on every
-- configuration install, so the GCS reporting runtime needs it. The managed
-- delivery binding loses the same three-column constraint, because a binding is
-- keyed by its Core configuration. Account configurations keep an empty
-- subscription_key, so every existing row keeps exactly its uniqueness. The
-- blocks are verbatim from REPORTING_LEDGER_MIGRATION and
-- REPORTING_MANAGED_DELIVERY_MIGRATION and idempotent in the same schema.
DO $schema_precondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'training_reporting_gcs') THEN
    RAISE EXCEPTION 'Provision training_reporting_gcs for the application role before migration 637';
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
  IF to_regclass('adcp_reporting_configurations') IS NULL
    OR to_regclass('adcp_reporting_managed_bindings') IS NULL THEN
    RAISE EXCEPTION 'Apply training GCS reporting migration 620 before migration 637';
  END IF;
END;
$table_precondition$;

-- Principal-level reporting subscriptions (AdCP 3.3) install one generation per owning principal
-- and resolved offering under the same (account, delivery_config_id, delivery_config_version):
-- subscription_key digests the owner and offering, and stays empty for every account generation,
-- so existing rows keep exactly their uniqueness. The column is added under a catalog guard
-- because ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE even when the column exists. The
-- widened unique index is built before the published three-column constraint is dropped, and that
-- constraint is found by its columns rather than by a guessed name.
DO $subscription_key$
DECLARE
  configurations regclass := to_regclass('adcp_reporting_configurations');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = configurations AND attname = 'subscription_key' AND NOT attisdropped
  ) THEN
    ALTER TABLE adcp_reporting_configurations ADD COLUMN subscription_key TEXT NOT NULL DEFAULT '';
  END IF;
END
$subscription_key$;
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_configurations_generation
  ON adcp_reporting_configurations (account_id, delivery_config_id, delivery_config_version, subscription_key);
DO $subscription_unique$
DECLARE
  configurations regclass := to_regclass('adcp_reporting_configurations');
  legacy RECORD;
BEGIN
  FOR legacy IN
    SELECT constraint_row.conname
      FROM pg_constraint constraint_row
     WHERE constraint_row.conrelid = configurations
       AND constraint_row.contype = 'u'
       AND (
         SELECT array_agg(attribute.attname::text ORDER BY attribute.attname::text)
           FROM unnest(constraint_row.conkey) AS key(attnum)
           JOIN pg_attribute attribute
             ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum
       ) = ARRAY['account_id', 'delivery_config_id', 'delivery_config_version']::text[]
  LOOP
    EXECUTE format('ALTER TABLE adcp_reporting_configurations DROP CONSTRAINT %I', legacy.conname);
  END LOOP;
END
$subscription_unique$;

-- A binding is keyed by its Core configuration (the primary key). Principal-level reporting
-- subscriptions (AdCP 3.3) install one Core configuration per owning principal and resolved
-- offering under one (account, delivery_config_id, delivery_config_version), so the published
-- three-column constraint would refuse their bindings. Core configurations stay unique per
-- (account, id, version, subscription_key), so every account binding keeps its uniqueness. The
-- constraint is found by its columns, not by a guessed name, and the block is idempotent.
DO $binding_configuration_key$
DECLARE
  bindings regclass := to_regclass('adcp_reporting_managed_bindings');
  legacy RECORD;
BEGIN
  FOR legacy IN
    SELECT constraint_row.conname
      FROM pg_constraint constraint_row
     WHERE constraint_row.conrelid = bindings
       AND constraint_row.contype = 'u'
       AND (
         SELECT array_agg(attribute.attname::text ORDER BY attribute.attname::text)
           FROM unnest(constraint_row.conkey) AS key(attnum)
           JOIN pg_attribute attribute
             ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum
       ) = ARRAY['account_id', 'delivery_config_id', 'delivery_config_version']::text[]
  LOOP
    EXECUTE format('ALTER TABLE adcp_reporting_managed_bindings DROP CONSTRAINT %I', legacy.conname);
  END LOOP;
END
$binding_configuration_key$;
CREATE INDEX IF NOT EXISTS adcp_reporting_managed_bindings_generation
  ON adcp_reporting_managed_bindings (account_id, delivery_config_id, delivery_config_version);
