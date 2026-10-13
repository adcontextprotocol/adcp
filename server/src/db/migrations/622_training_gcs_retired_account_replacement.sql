-- Keep retired bindings and authorization tombstones instead of replacing
-- immutable account facts. Application reservations serialize by principal
-- and require every prior account's exact grant to be durably revoked.
DO $schema_precondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'training_reporting_gcs') THEN
    RAISE EXCEPTION 'Provision training_reporting_gcs before migration 622';
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

-- Older runtimes still rely on INSERT ... ON CONFLICT DO NOTHING. Keep the
-- fence authoritative while the release command runs ahead of their rollout.
CREATE OR REPLACE FUNCTION host_canary_account_reservation_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
SET lock_timeout = '3s'
AS $guard$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('training-gcs-account:' || NEW.principal_id, 0));
  IF EXISTS (
    SELECT 1 FROM training_reporting_gcs.adcp_reporting_destination_authorizations
     WHERE account_id = NEW.account_id AND destination_ref = NEW.destination_ref AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This canary destination is retired. Provision a new account.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM training_reporting_gcs.host_accounts prior
     WHERE prior.principal_id = NEW.principal_id AND prior.account_id <> NEW.account_id AND (
       NOT EXISTS (
         SELECT 1 FROM training_reporting_gcs.host_grants destination_grant
           JOIN training_reporting_gcs.adcp_reporting_destination_authorizations auth
             ON auth.account_id = destination_grant.account_id AND auth.destination_ref = destination_grant.destination_ref
            AND auth.generation = destination_grant.generation
          WHERE destination_grant.account_id = prior.account_id AND destination_grant.destination_ref = prior.destination_ref
            AND auth.revoked_at IS NOT NULL
       ) OR EXISTS (
         SELECT 1 FROM training_reporting_gcs.adcp_reporting_destination_authorizations auth
          WHERE auth.account_id = prior.account_id AND auth.revoked_at IS NULL
       )
     )
  ) THEN
    RAISE EXCEPTION 'The canary organization has an active or unfinished account.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION host_canary_account_reservation_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS host_canary_account_reservation ON host_accounts;
CREATE TRIGGER host_canary_account_reservation BEFORE INSERT ON host_accounts
  FOR EACH ROW EXECUTE FUNCTION host_canary_account_reservation_guard();

ALTER TABLE host_accounts DROP CONSTRAINT IF EXISTS host_accounts_principal_id_key;
CREATE INDEX IF NOT EXISTS host_accounts_principal_id
  ON host_accounts (principal_id);
