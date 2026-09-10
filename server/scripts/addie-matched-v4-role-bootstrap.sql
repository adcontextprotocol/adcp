-- Authenticated migration-principal attestation for migration 584. This file
-- is deliberately not a numbered application migration. The static roles and
-- their two membership bridges are an independently administered DBA
-- prerequisite; this file must never create, repair, or grant them.
--
-- Example (the caller authenticates as the already-provisioned migration
-- principal):
--   psql "$MATCHED_V4_MIGRATION_URL" --single-transaction -v runtime_principal=adcp_runtime \
--     -v migration_principal=adcp_migrator \
--     -f server/scripts/addie-matched-v4-role-bootstrap.sql
--
-- PostgreSQL 16 gives a CREATEROLE principal an implicit ADMIN membership
-- edge for every role it creates. Such an edge cannot safely be revoked by
-- that least-privilege principal because it is recorded under the DBA grantor.
-- Therefore the DBA must create both static NOLOGIN roles and grant only:
--   addie_matched_v4_runtime -> runtime_principal
--   addie_matched_v4_operator -> migration_principal
-- before this attestation. The migration principal has no CREATEROLE and may
-- assume only the operator role for the separately invoked evaluator DDL.
\set ON_ERROR_STOP on
\if :{?runtime_principal}
\else
\echo 'missing required psql variable runtime_principal'
DO $$ BEGIN RAISE EXCEPTION 'missing required psql variable runtime_principal'; END $$;
\quit 1
\endif
\if :{?migration_principal}
\else
\echo 'missing required psql variable migration_principal'
DO $$ BEGIN RAISE EXCEPTION 'missing required psql variable migration_principal'; END $$;
\quit 1
\endif

SELECT :'runtime_principal' = :'migration_principal' AS matched_v4_same_principal \gset
\if :matched_v4_same_principal
\echo 'matched-v4 runtime_principal and migration_principal must differ'
DO $$ BEGIN RAISE EXCEPTION 'matched-v4 runtime_principal and migration_principal must differ'; END $$;
\quit 1
\endif

-- Never let an arbitrary admin connection nominate another principal as the
-- evaluator operator bridge. `current_user` alone is insufficient: a
-- superuser (or role member) can SET ROLE before invoking this file. The
-- authenticated/session identity must itself be the declared provisioner
-- before this script attests the external role graph or permits SET ROLE.
SELECT current_user = :'migration_principal'
  AND session_user = :'migration_principal'
  AS matched_v4_authenticated_migration_principal \gset
\if :matched_v4_authenticated_migration_principal
\else
\echo 'matched-v4 bootstrap session_user and current_user must equal migration_principal'
DO $$ BEGIN RAISE EXCEPTION 'matched-v4 bootstrap session_user and current_user must equal migration_principal'; END $$;
\quit 1
\endif

-- This is a pure, fail-closed attestation. In particular it does not repair a
-- malformed role graph: that would make an application-visible migration
-- principal a covert role administrator.
SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles
  WHERE rolname = :'runtime_principal'
    AND rolcanlogin AND rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls
) AND EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles
  WHERE rolname = :'migration_principal'
    AND rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls
) AND EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'addie_matched_v4_operator'
    AND NOT rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls
) AND EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'addie_matched_v4_runtime'
    AND NOT rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls
) AND pg_catalog.pg_has_role(:'runtime_principal', 'addie_matched_v4_runtime', 'member')
  AND pg_catalog.pg_has_role(:'migration_principal', 'addie_matched_v4_operator', 'member')
  AND NOT pg_catalog.pg_has_role(:'runtime_principal', 'addie_matched_v4_operator', 'member')
  AND NOT pg_catalog.pg_has_role(:'migration_principal', 'addie_matched_v4_runtime', 'member')
  -- pg_has_role is transitive. Pin the two physical PostgreSQL 16 membership
  -- edges as well: the app may inherit runtime permissions but may not SET
  -- ROLE or administer it; the migration login may SET ROLE to operator but
  -- may neither inherit nor administer it. The grantor must be a distinct
  -- external DBA, not either protected role or either named login.
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members edge
    WHERE edge.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_runtime')
      AND edge.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :'runtime_principal')
      AND edge.inherit_option AND NOT edge.set_option AND NOT edge.admin_option
      AND edge.grantor NOT IN (
        edge.roleid, edge.member,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_operator'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :'migration_principal')
      )
  )
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members edge
    WHERE edge.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_operator')
      AND edge.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :'migration_principal')
      AND NOT edge.inherit_option AND edge.set_option AND NOT edge.admin_option
      AND edge.grantor NOT IN (
        edge.roleid, edge.member,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_runtime'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :'runtime_principal')
      )
  )
  -- The static evaluator roles have exactly the two direct members above.
  -- This rejects a hidden direct bridge even if it is non-inheritable today;
  -- otherwise an administrator could later flip SET/INHERIT/ADMIN options
  -- without changing the named role graph.
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members edge
    WHERE edge.roleid IN (
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_runtime'),
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_operator')
    )
      AND NOT (
        edge.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_runtime')
        AND edge.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :'runtime_principal')
        AND edge.inherit_option AND NOT edge.set_option AND NOT edge.admin_option
      )
      AND NOT (
        edge.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_operator')
        AND edge.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :'migration_principal')
        AND NOT edge.inherit_option AND edge.set_option AND NOT edge.admin_option
      )
  )
  -- The static roles must be leaves too. A parent role can make an otherwise
  -- unprivileged evaluator capability transitively SET or inherit an elevated
  -- privilege without changing either reviewed direct bridge.
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members edge
    WHERE edge.member IN (
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_runtime'),
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_operator')
    )
  )
  AS matched_v4_completed_least_privilege_bridges \gset
\if :matched_v4_completed_least_privilege_bridges
\else
\echo 'matched-v4 requires externally provisioned static roles and exact least-privilege bridges'
DO $$ BEGIN RAISE EXCEPTION 'matched-v4 requires externally provisioned static roles and exact least-privilege bridges'; END $$;
\quit 1
\endif
