-- SDK 15.9.2 reporting migration deltas over the SQL in migrations 620 and 621.
-- PostgresReportingManagedDeliveryStore.authorizeDestination, installBinding and
-- claimRevocation (run by every managed delivery worker pass) read and write the
-- destination authorization pattern/transport columns unconditionally, so the
-- GCS reporting runtime needs them even with nothing to revoke. The tombstone
-- retry columns keep REPORTING_LEDGER_MIGRATION parity; only period retention,
-- which the training runtime does not enable, reads them. Both blocks are
-- verbatim from the SDK, additive and idempotent in the same schema.
DO $schema_precondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'training_reporting_gcs') THEN
    RAISE EXCEPTION 'Provision training_reporting_gcs for the application role before migration 624';
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

-- Delivery pattern and transport recorded on the authorization generation, so
-- a revocation can be routed to the transport that holds the provider grant.
-- Both are immutable for a generation (a new delivery contract mints a new
-- destination_ref generation) and NULL for a generation whose contract is not
-- known. The block runs once, in the same statement batch that adds the
-- columns: it backfills a row only when every binding on that exact
-- (account_id, destination_ref, generation) agrees on the method and carries
-- the same transport, and otherwise leaves the row NULL. A later re-run finds
-- the columns present and does nothing, so a generation that was left NULL
-- stays NULL rather than being re-decided by whichever binding arrived since.
DO $pattern_transport$
DECLARE
  unresolved BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'adcp_reporting_destination_authorizations'
       AND column_name = 'transport'
  ) THEN
    ALTER TABLE adcp_reporting_destination_authorizations ADD COLUMN IF NOT EXISTS pattern TEXT;
    ALTER TABLE adcp_reporting_destination_authorizations ADD COLUMN IF NOT EXISTS transport TEXT;
    WITH agreed AS (
      SELECT authz.account_id, authz.destination_ref, authz.generation,
             MIN(binding.data->>'method') AS pattern,
             MIN(binding.data->>'transport') AS transport
        FROM adcp_reporting_destination_authorizations authz
        JOIN adcp_reporting_managed_bindings binding
          ON binding.account_id = authz.account_id
         AND binding.destination_ref = authz.destination_ref
         AND binding.authorization_generation = authz.generation
       WHERE authz.pattern IS NULL AND authz.transport IS NULL
       GROUP BY authz.account_id, authz.destination_ref, authz.generation
      HAVING COUNT(*) = COUNT(binding.data->>'method')
         AND COUNT(DISTINCT binding.data->>'method') = 1
         AND COUNT(*) = COUNT(binding.data->>'transport')
         AND COUNT(DISTINCT binding.data->>'transport') = 1
    )
    UPDATE adcp_reporting_destination_authorizations authz
       SET pattern = agreed.pattern,
           transport = agreed.transport,
           data = authz.data || jsonb_build_object('pattern', agreed.pattern, 'transport', agreed.transport)
      FROM agreed
     WHERE authz.account_id = agreed.account_id
       AND authz.destination_ref = agreed.destination_ref
       AND authz.generation = agreed.generation;
    SELECT COUNT(*) INTO unresolved FROM adcp_reporting_destination_authorizations WHERE transport IS NULL;
    IF unresolved > 0 THEN
      RAISE NOTICE 'adcp_reporting_destination_authorizations: % generation(s) left without pattern/transport; list them with PostgresReportingManagedDeliveryStore.listDestinationAuthorizationsWithoutContract()', unresolved;
    END IF;
  END IF;
END
$pattern_transport$;

DO $tombstone_retry$
DECLARE
  tombstones regclass := to_regclass('adcp_reporting_obligation_tombstones');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tombstones AND attname = 'attempts' AND NOT attisdropped) THEN
    ALTER TABLE adcp_reporting_obligation_tombstones ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tombstones AND attname = 'next_attempt_at' AND NOT attisdropped) THEN
    ALTER TABLE adcp_reporting_obligation_tombstones ADD COLUMN next_attempt_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tombstones AND attname = 'last_failure' AND NOT attisdropped) THEN
    ALTER TABLE adcp_reporting_obligation_tombstones ADD COLUMN last_failure TEXT;
  END IF;
END
$tombstone_retry$;
