import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { PoolClient } from "pg";
import { getPool, initializeDatabase } from "./client.js";
import { DatabaseConfig } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Migration {
  filename: string;
  version: number;
  sql: string;
}

/**
 * Migration filename format: NNN_description.sql
 * Example: 001_initial.sql, 002_add_indexes.sql
 */
const MIGRATION_FILENAME_PATTERN = /^(\d+)_(.+)\.sql$/;
const MATCHED_V4_EXTERNAL_MIGRATIONS = new Set([
  "584_addie_matched_v4_private_authority.sql",
  "585_addie_matched_v4_record_estimated_cost.sql",
]);
const MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED_ENV =
  "ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED";
/** Matches migration 585 and the protected evaluator workflow. */
const MATCHED_V4_EVALUATOR_LOCK_KEY = 584585;

/**
 * Evaluator DDL is intentionally opt-in for the protected release path. Local
 * development, previews, and ordinary application migration boots neither
 * create nor attest the private evaluator schema. This flag cannot authorize
 * paid execution: admission still requires the independent one-use operator
 * claim in the sealed authority.
 */
function matchedV4EvaluatorSchemaRequired(): boolean {
  const configured = process.env[MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED_ENV];
  if (configured === undefined || configured === "false") return false;
  if (configured === "true") return true;
  throw new Error(
    `${MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED_ENV} must be exactly true or false`,
  );
}

/**
 * Migrations 584 and 585 are intentionally applied by a separately
 * administered evaluator operator, not by the general application migrator.
 * The normal ledger records either only after both external steps attest the
 * transformed terminal-record schema. This makes 585 a hard prerequisite for
 * an admission: the application cannot record a usable 584-only boundary.
 */
async function validateMatchedV4ExternalSchema(
  client: PoolClient,
): Promise<void> {
  const transformed = await client.query<{ valid: boolean }>(`
    WITH required_tables(name) AS (
      VALUES ('addie_matched_v4_private_runs'),
        ('addie_matched_v4_private_admissions'),
        ('addie_matched_v4_private_attempts')
    ), required_relations(name, relkind) AS (
      VALUES ('addie_matched_v4_private_runs', 'r'::"char"),
        ('addie_matched_v4_private_runs_pkey', 'i'::"char"),
        ('addie_matched_v4_private_admissions', 'r'::"char"),
        ('addie_matched_v4_private_admissions_pkey', 'i'::"char"),
        ('addie_matched_v4_private_admi_merge_sha_authority_manifest__key', 'i'::"char"),
        ('addie_matched_v4_private_attempts', 'r'::"char"),
        ('addie_matched_v4_private_attempts_pkey', 'i'::"char"),
        ('addie_matched_v4_private_attempts_reservation_id_ordinal_key', 'i'::"char")
    ), required_api(signature, runtime_execute) AS (
      VALUES ('public.addie_matched_v4_private_reserve(text,text,text,integer)', true),
        ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)', true),
        ('public.addie_matched_v4_private_record_response_usage(text,text,text,text,bigint)', true),
        ('public.addie_matched_v4_private_reconcile(text)', true),
        ('public.addie_matched_v4_private_halt(text,text)', true),
        ('public.addie_matched_v4_private_claim_admission(text,text,text)', true)
    ), protected_guards(signature) AS (
      VALUES ('public.addie_matched_v4_private_attempt_guard()'),
        ('public.addie_matched_v4_private_append_only_guard()')
    ), canonical_triggers(table_name, trigger_name, procedure_signature, trigger_type) AS (
      VALUES ('addie_matched_v4_private_attempts', 'addie_matched_v4_private_attempt_guard', 'public.addie_matched_v4_private_attempt_guard()', 31),
        ('addie_matched_v4_private_runs', 'addie_matched_v4_private_runs_append_only_guard', 'public.addie_matched_v4_private_append_only_guard()', 11),
        ('addie_matched_v4_private_admissions', 'addie_matched_v4_private_admissions_append_only_guard', 'public.addie_matched_v4_private_append_only_guard()', 11),
        ('addie_matched_v4_private_attempts', 'addie_matched_v4_private_attempts_append_only_guard', 'public.addie_matched_v4_private_append_only_guard()', 11)
    )
    SELECT
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_runtime' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
      AND session_user = current_user
      -- The authenticated application login is itself a sealed bridge, not
      -- merely a member of the static runtime capability.  Pin its complete
      -- non-privileged shape before it can record the external boundary.
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolcanlogin AND rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
      AND pg_catalog.pg_has_role(current_user, 'addie_matched_v4_runtime', 'member')
      AND NOT pg_catalog.pg_has_role(current_user, 'addie_matched_v4_operator', 'member')
      AND NOT pg_catalog.pg_has_role('addie_matched_v4_runtime', 'addie_matched_v4_operator', 'member')
      -- Neither static custody capability may itself inherit or SET another
      -- role. Otherwise its harmless-looking own flags conceal a transitive
      -- privilege escalation outside the reviewed two-bridge graph.
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE edge.member IN ('addie_matched_v4_operator'::regrole,'addie_matched_v4_runtime'::regrole))
      -- Both static evaluator capabilities have exactly one reviewed direct
      -- bridge. A second hidden SET member is an admission bypass.
      AND (SELECT count(*) FROM pg_catalog.pg_auth_members edge WHERE edge.roleid='addie_matched_v4_operator'::regrole) = 1
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge JOIN pg_catalog.pg_roles member_role ON member_role.oid=edge.member WHERE edge.roleid='addie_matched_v4_operator'::regrole AND NOT edge.inherit_option AND edge.set_option AND NOT edge.admin_option AND member_role.rolcanlogin AND NOT member_role.rolinherit AND NOT member_role.rolsuper AND NOT member_role.rolcreatedb AND NOT member_role.rolcreaterole AND NOT member_role.rolreplication AND NOT member_role.rolbypassrls AND edge.grantor NOT IN (edge.roleid,edge.member,'addie_matched_v4_runtime'::regrole,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members bridge JOIN pg_catalog.pg_auth_members edge ON edge.member=bridge.member WHERE bridge.roleid='addie_matched_v4_operator'::regrole AND edge.roleid<>'addie_matched_v4_operator'::regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members bridge JOIN pg_catalog.pg_auth_members edge ON edge.roleid=bridge.member WHERE bridge.roleid='addie_matched_v4_operator'::regrole)
      AND (SELECT count(*) FROM pg_catalog.pg_auth_members edge WHERE edge.roleid='addie_matched_v4_runtime'::regrole) = 1
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE edge.roleid='addie_matched_v4_runtime'::regrole AND edge.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AND edge.inherit_option AND NOT edge.set_option AND NOT edge.admin_option AND edge.grantor NOT IN (edge.roleid,edge.member,'addie_matched_v4_operator'::regrole,(SELECT member FROM pg_catalog.pg_auth_members WHERE roleid='addie_matched_v4_operator'::regrole)))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE edge.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AND edge.roleid<>'addie_matched_v4_runtime'::regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE edge.roleid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
      AND current_setting('session_replication_role') = 'origin'
      AND NOT pg_catalog.has_parameter_privilege('addie_matched_v4_runtime','session_replication_role','SET')
      AND NOT pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting setting CROSS JOIN LATERAL unnest(setting.setconfig) config WHERE setting.setrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AND setting.setdatabase IN (0,(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())) AND split_part(config,'=',1)='session_replication_role' AND split_part(config,'=',2)<>'origin')
      AND pg_catalog.has_schema_privilege('addie_matched_v4_operator', 'public', 'USAGE')
      AND pg_catalog.has_schema_privilege('addie_matched_v4_operator', 'public', 'CREATE')
      AND pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'public', 'USAGE')
      AND NOT pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'public', 'CREATE')
      AND pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
      AND NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'pg_toast', 'USAGE,CREATE')
      AND NOT pg_catalog.has_schema_privilege(current_user, 'pg_toast', 'USAGE,CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type='CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))) AND (acl.grantee<>c.relowner OR acl.grantor<>c.relowner OR acl.is_grantable))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))) AND (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner)))) <> 7)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))) AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      -- Every prefixed relation, including physical indexes, is a reviewed
      -- object. This rejects shadow views, sequences, and partitions too.
      AND (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'addie_matched_v4_private_%') = 8
      AND (SELECT count(*) FROM pg_catalog.pg_class WHERE relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')) = 14
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator') AND c.oid NOT IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_runs_pkey'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_admissions_pkey'),to_regclass('public.addie_matched_v4_private_admi_merge_sha_authority_manifest__key'),to_regclass('public.addie_matched_v4_private_attempts'),to_regclass('public.addie_matched_v4_private_attempts_pkey'),to_regclass('public.addie_matched_v4_private_attempts_reservation_id_ordinal_key')) AND c.oid NOT IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))))
      AND NOT EXISTS (SELECT 1 FROM required_relations WHERE to_regclass('public.' || name) IS NULL
        OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || name)) <> required_relations.relkind
        OR (SELECT c.relpersistence FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || name)) <> 'p'
        OR (required_relations.relkind='r'::"char" AND (SELECT c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules OR c.relispartition FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || name)))
        OR (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || name)) <> 'addie_matched_v4_operator'
        OR (required_relations.relkind='i'::"char" AND (SELECT c.relacl FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || name)) IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM required_tables WHERE to_regclass('public.' || name) IS NULL
        OR (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid=to_regclass('public.' || name)) <> 'addie_matched_v4_operator'
        OR pg_catalog.has_table_privilege(current_user, 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid=to_regclass('public.' || name) AND (acl.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator') OR acl.grantor<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator') OR acl.is_grantable))
        OR (SELECT count(*) FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid=to_regclass('public.' || name)) <> 7)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) AND r.rulename <> '_RETURN')
      -- A view can expose toasted values directly. Its rewrite dependencies
      -- must not name either a custody table or its physical TOAST relation.
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid WHERE r.ev_class NOT IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) AND d.refobjid IN (SELECT c.oid FROM pg_catalog.pg_class c WHERE c.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT c.reltoastrelid FROM pg_catalog.pg_class c WHERE c.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) AND c.reltoastrelid <> 0))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) OR i.inhparent IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(ARRAY[to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')]) AND a.attnum>0 AND NOT a.attisdropped AND (a.attacl IS NOT NULL OR pg_catalog.has_column_privilege(current_user,a.attrelid,a.attnum,'SELECT') OR pg_catalog.has_column_privilege(current_user,a.attrelid,a.attnum,'INSERT') OR pg_catalog.has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE') OR pg_catalog.has_column_privilege(current_user,a.attrelid,a.attnum,'REFERENCES')))
      AND (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.addie_matched_v4_private_attempts') AND attnum>0 AND NOT attisdropped) = 13
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.addie_matched_v4_private_attempts') AND attname='estimated_cost_microdollars' AND pg_catalog.format_type(atttypid,atttypmod)='bigint')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.addie_matched_v4_private_attempts') AND attname='terminal_recorded_at' AND pg_catalog.format_type(atttypid,atttypmod)='timestamp with time zone')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.addie_matched_v4_private_attempts') AND attname IN ('cost_microdollars','settled_at'))
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=to_regclass('public.addie_matched_v4_private_attempts') AND conname='addie_matched_v4_private_attempts_terminal_recording_check' AND pg_catalog.pg_get_constraintdef(oid,true) LIKE '%response_usage_recorded%')
      AND to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)') IS NULL
      AND NOT EXISTS (SELECT 1 FROM required_api WHERE to_regprocedure(signature) IS NULL
        OR NOT pg_catalog.has_function_privilege('addie_matched_v4_runtime', signature, 'EXECUTE')
        OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(signature))
        OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(signature)) IS DISTINCT FROM ARRAY['search_path=pg_catalog']
        OR (SELECT pg_catalog.pg_get_userbyid(proowner) FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(signature)) <> 'addie_matched_v4_operator'
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE p.oid=to_regprocedure(signature) AND acl.grantee=0 AND acl.privilege_type='EXECUTE'))
      AND NOT EXISTS (SELECT 1 FROM protected_guards WHERE to_regprocedure(signature) IS NULL
        OR (SELECT pg_catalog.pg_get_userbyid(proowner) FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(signature)) <> 'addie_matched_v4_operator'
        OR pg_catalog.has_function_privilege('addie_matched_v4_runtime', signature, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE p.oid=to_regprocedure(signature) AND acl.grantee=0 AND acl.privilege_type='EXECUTE'))
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT signature, runtime_execute FROM required_api
          UNION ALL SELECT signature, false FROM protected_guards
        ) AS expected
        WHERE (SELECT count(*) FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE p.oid=to_regprocedure(expected.signature)) <> CASE WHEN expected.runtime_execute THEN 2 ELSE 1 END
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE p.oid=to_regprocedure(expected.signature) AND (acl.grantee NOT IN ((SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator'),(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_runtime')) OR acl.grantor <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator') OR acl.is_grantable))
      )
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname='addie_matched_v4_private_attempt_guard' AND t.tgrelid=to_regclass('public.addie_matched_v4_private_attempts') AND t.tgfoid=to_regprocedure('public.addie_matched_v4_private_attempt_guard()') AND t.tgtype=31 AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgargs=''::bytea AND NOT t.tgisinternal)
      AND NOT EXISTS (SELECT 1 FROM canonical_triggers expected WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=to_regclass('public.' || expected.table_name) AND t.tgname=expected.trigger_name AND t.tgfoid=to_regprocedure(expected.procedure_signature) AND t.tgtype=expected.trigger_type AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgargs=''::bytea AND NOT t.tgisinternal))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger actual WHERE NOT actual.tgisinternal AND actual.tgrelid=ANY(ARRAY[to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')]) AND NOT EXISTS (SELECT 1 FROM canonical_triggers expected WHERE actual.tgrelid=to_regclass('public.' || expected.table_name) AND actual.tgname=expected.trigger_name AND actual.tgfoid=to_regprocedure(expected.procedure_signature) AND actual.tgtype=expected.trigger_type AND actual.tgenabled='O' AND actual.tgqual IS NULL AND actual.tgattr=''::int2vector AND actual.tgargs=''::bytea))
      -- The one reviewed foreign key has exactly four enabled internal RI
      -- triggers. An incoming FK on another relation must not silently add
      -- enforcement objects to this sealed namespace.
      AND (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint WHERE t.tgisinternal AND t.tgconstraint <> 0 AND (c.conrelid=ANY(ARRAY[to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')]) OR c.confrelid=ANY(ARRAY[to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')]))) = 4
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid WHERE t.tgisinternal AND t.tgconstraint <> 0 AND (c.conrelid=ANY(ARRAY[to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')]) OR c.confrelid=ANY(ARRAY[to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')])) AND NOT EXISTS (SELECT 1 FROM (VALUES
        ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_runs','RI_FKey_restrict_del',9),
        ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_runs','RI_FKey_noaction_upd',17),
        ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_attempts','RI_FKey_check_ins',5),
        ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_attempts','RI_FKey_check_upd',17)
      ) AS expected(constraint_name,source_table,target_table,trigger_table,procedure_name,trigger_type) WHERE c.conname=expected.constraint_name AND c.conrelid=to_regclass('public.' || expected.source_table) AND c.confrelid=to_regclass('public.' || expected.target_table) AND t.tgrelid=to_regclass('public.' || expected.trigger_table) AND p.pronamespace='pg_catalog'::regnamespace AND p.proname=expected.procedure_name AND t.tgtype=expected.trigger_type AND t.tgenabled='O' AND t.tgqual IS NULL))
      -- A successful migration record needs a full 585 shape attestation,
      -- not a same-name/status lookalike. These digests cover every ordered
      -- column, constraint, and physical index, plus complete definitions of
      -- both guards and all callable SECURITY DEFINER functions.
      AND NOT EXISTS (SELECT 1 FROM (VALUES
        ('addie_matched_v4_private_admissions','4ed0c46ae7eaee829b967b8c8eeb1996'),
        ('addie_matched_v4_private_attempts','8dc693482e69a981110ffa1c547b1f69'),
        ('addie_matched_v4_private_runs','16a018c611239801d31c7855ca8c1a28')
      ) AS expected(name,shape_md5) WHERE expected.shape_md5 IS DISTINCT FROM (
        SELECT md5((jsonb_build_object('table',c.relname,'relkind',c.relkind,
          'columns',(SELECT jsonb_agg(jsonb_build_object('ordinal',a.attnum,'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''),'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE (SELECT n.nspname || '.' || co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation) END,'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
          'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'definition',pg_catalog.pg_get_constraintdef(x.oid,true)) ORDER BY x.conname) FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),
          'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ci.relname,'definition',pg_catalog.pg_get_indexdef(i.indexrelid,0,true)) ORDER BY ci.relname) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid)
        )::text)) FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)
      ))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) AND a.attnum>0 AND a.attisdropped)
      AND (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'addie_matched_v4_private_%')=8
      AND (SELECT count(*) FROM pg_catalog.pg_proc WHERE proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator'))=8
      AND NOT EXISTS (SELECT 1 FROM (VALUES
        ('public.addie_matched_v4_private_attempt_guard()','ee4c62ffa52a33ee8144416274051bc6'),
        ('public.addie_matched_v4_private_append_only_guard()','b66c0828506e4785edf27b41190c3ed9'),
        ('public.addie_matched_v4_private_reserve(text,text,text,integer)','a246e0fa7b05238e52f384138ec99047'),
        ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)','85c35d25f690969ed336fe7a9e30115d'),
        ('public.addie_matched_v4_private_record_response_usage(text,text,text,text,bigint)','0d8ab008dd3d5d3354c528324432dc40'),
        ('public.addie_matched_v4_private_reconcile(text)','87d8997b5c7408461244e7bd740d044f'),
        ('public.addie_matched_v4_private_halt(text,text)','2d35d780d2279dc302db1bc27967c8f9'),
        ('public.addie_matched_v4_private_claim_admission(text,text,text)','4db729c5722fd978efebf52ace62bb6a')
      ) AS expected(signature,definition_md5) WHERE to_regprocedure(expected.signature) IS NULL
        OR expected.definition_md5 IS DISTINCT FROM (SELECT md5(pg_catalog.pg_get_functiondef(to_regprocedure(expected.signature)))))
      AS valid
  `);
  if (!transformed.rows[0]?.valid) {
    throw new Error(
      "Migrations 584 and 585 require the externally administered transformed matched-v4 evaluator schema. " +
        "Run the protected evaluator bootstrap/control-plane job before the ordinary application migration.",
    );
  }
}

/**
 * Parse and validate migration filename
 */
function parseMigrationFilename(
  filename: string,
): { version: number; description: string } | null {
  const match = filename.match(MIGRATION_FILENAME_PATTERN);
  if (!match) {
    return null;
  }

  const version = parseInt(match[1], 10);
  if (isNaN(version)) {
    return null;
  }

  return {
    version,
    description: match[2],
  };
}

/**
 * Load all migration files
 */
async function loadMigrations(): Promise<Migration[]> {
  const migrationsDir = path.join(__dirname, "migrations");
  const files = await fs.readdir(migrationsDir);

  const migrations: Migration[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (file.endsWith(".sql")) {
      const parsed = parseMigrationFilename(file);

      if (!parsed) {
        errors.push(
          `Invalid migration filename: ${file}. Expected format: NNN_description.sql (e.g., 001_initial.sql)`,
        );
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, "utf-8");

      migrations.push({
        filename: file,
        version: parsed.version,
        sql,
      });
    }
  }

  // Detect duplicate version numbers (concurrent PRs picking the same number)
  const seen = new Map<number, string>();
  for (const m of migrations) {
    const existing = seen.get(m.version);
    if (existing) {
      errors.push(
        `Duplicate migration version ${m.version}: ${existing} and ${m.filename}`,
      );
    }
    seen.set(m.version, m.filename);
  }

  if (errors.length > 0) {
    throw new Error(
      `Migration filename validation failed:\n${errors.join("\n")}`,
    );
  }

  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * Create migrations tracking table
 */
async function createMigrationsTable(): Promise<void> {
  const pool = getPool();

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version INTEGER PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  } catch (error) {
    // The matched-v4 runtime may resolve objects in public but must not create
    // them. PostgreSQL checks schema CREATE even for CREATE TABLE IF NOT EXISTS
    // when the relation already exists, so retain a DBA-created ledger without
    // widening the runtime schema grant.
    if ((error as { code?: string }).code !== "42501") throw error;
    const existing = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    );
    if (existing.rows?.[0]?.exists) return;
    throw error;
  }
}

/**
 * Get list of applied migrations with filenames
 */
async function getAppliedMigrations(): Promise<
  Array<{ version: number; filename: string }>
> {
  const pool = getPool();

  const result = await pool.query<{ version: number; filename: string }>(
    "SELECT version, filename FROM public.schema_migrations ORDER BY version",
  );

  return result.rows;
}

/**
 * Apply a single migration
 */
async function applyMigration(migration: Migration): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");

    if (MATCHED_V4_EXTERNAL_MIGRATIONS.has(migration.filename)) {
      // Keep the exact catalog read and this migration's ledger record in the
      // same cooperative serialization domain as protected evaluator
      // DDL/admission.
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        MATCHED_V4_EVALUATOR_LOCK_KEY,
      ]);
      await validateMatchedV4ExternalSchema(client);
    } else {
      await client.query(migration.sql);
    }

    // Record migration
    await client.query(
      "INSERT INTO public.schema_migrations (version, filename) VALUES ($1, $2)",
      [migration.version, migration.filename],
    );

    await client.query("COMMIT");

    console.log(`✓ Applied migration: ${migration.filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`✗ Failed to apply migration: ${migration.filename}`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Stable session-scoped pg advisory lock key. Any concurrent caller of
 * runMigrations() blocks on this key until the holder releases — prevents
 * two processes (release_command + a stray app boot, two devs locally,
 * etc.) from racing on schema_migrations or applying the same migration
 * twice.
 *
 * 0x6D696772 = ASCII "migr". Fits in int32 so it routes to the
 * pg_advisory_lock(bigint) overload without ambiguity.
 */
const MIGRATION_LOCK_KEY = 0x6d696772;

/**
 * Run all pending migrations
 */
export async function runMigrations(config?: DatabaseConfig): Promise<void> {
  // Initialize database if config provided
  if (config) {
    initializeDatabase(config);
  }

  const pool = getPool();
  const lockClient = await pool.connect();
  try {
    await acquireMigrationLock(lockClient);
    await runMigrationsLocked();
  } finally {
    // Don't let unlock failures shadow a real migration error. Session-scoped
    // locks are released automatically by pg when the connection closes.
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [
        MIGRATION_LOCK_KEY,
      ]);
    } catch (err) {
      console.warn("Failed to release migration advisory lock:", err);
    }
    lockClient.release();
  }
}

/**
 * Acquire the migration advisory lock, bounded by a 5-minute statement_timeout
 * so a wedged prior session doesn't hang the deploy until pg keepalive reaps it
 * (default ≈2 hours). The timeout only caps how long we *wait* for the lock —
 * once acquired, we clear the timeout so the migration itself can run as long
 * as it needs.
 *
 * pg error code 57014 = query_canceled (statement_timeout fired).
 */
const ACQUIRE_LOCK_TIMEOUT = "5min";

async function acquireMigrationLock(client: PoolClient): Promise<void> {
  await client.query(`SET statement_timeout = '${ACQUIRE_LOCK_TIMEOUT}'`);
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  } catch (err) {
    if ((err as { code?: string })?.code === "57014") {
      throw new Error(
        `Could not acquire migration advisory lock (key=${MIGRATION_LOCK_KEY}) within ${ACQUIRE_LOCK_TIMEOUT}. ` +
          `A prior runMigrations() session is likely wedged. Find the holder:\n` +
          `  SELECT pid, state, query_start, query FROM pg_stat_activity\n` +
          `  WHERE pid IN (SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${MIGRATION_LOCK_KEY});\n` +
          `Then terminate it: SELECT pg_terminate_backend(<pid>);`,
      );
    }
    throw err;
  } finally {
    await client.query("SET statement_timeout = 0");
  }
}

async function runMigrationsLocked(): Promise<void> {
  // Create migrations table
  await createMigrationsTable();

  // Load all migrations
  const migrations = await loadMigrations();
  const appliedMigrations = await getAppliedMigrations();
  const appliedVersions = new Set(appliedMigrations.map((m) => m.version));

  // Detect filename mismatches — a sign that a migration version was
  // claimed by a different file (numbering collision from concurrent PRs).
  // Collisions above MISMATCH_BASELINE block startup; older ones are
  // historical debt that get logged as warnings.
  const MISMATCH_BASELINE = 389;
  const appliedByVersion = new Map(
    appliedMigrations.map((m) => [m.version, m.filename]),
  );
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const m of migrations) {
    const appliedFilename = appliedByVersion.get(m.version);
    if (appliedFilename && appliedFilename !== m.filename) {
      const msg = `Migration ${m.version} on disk is "${m.filename}" but was applied as "${appliedFilename}"`;
      if (m.version > MISMATCH_BASELINE) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }
  if (warnings.length > 0) {
    console.warn(
      `⚠ Historical migration filename mismatches (pre-${MISMATCH_BASELINE}):\n${warnings.join("\n")}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `Migration filename mismatches detected (possible numbering collision):\n${errors.join("\n")}\n` +
        `Renumber the colliding migration(s) and redeploy.`,
    );
  }

  // Find pending migrations
  const pendingMigrations = migrations.filter((migration) => {
    if (appliedVersions.has(migration.version)) return false;
    if (!MATCHED_V4_EXTERNAL_MIGRATIONS.has(migration.filename)) return true;
    if (matchedV4EvaluatorSchemaRequired()) return true;
    // This is not an authorization control. It simply keeps evaluator-only
    // schema custody out of ordinary local/preview/application startup. The
    // protected release path sets the exact opt-in and performs the strict
    // full-catalog attestation in applyMigration before recording 584.
    console.info(`Skipping evaluator-only migration: ${migration.filename}`);
    return false;
  });

  if (pendingMigrations.length === 0) {
    // Quiet startup - no output when nothing to do
    return;
  }

  console.log(`Applying ${pendingMigrations.length} pending migrations...`);

  // Apply each pending migration
  for (const migration of pendingMigrations) {
    await applyMigration(migration);
  }

  console.log("✓ All migrations completed successfully");
}

/**
 * CLI runner for migrations
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  // SSL configuration - matches config.ts pattern
  let ssl: boolean | { rejectUnauthorized: boolean } = false;
  if (process.env.DATABASE_SSL === "true") {
    // Allow explicit control via DATABASE_SSL_REJECT_UNAUTHORIZED
    const rejectUnauthorized =
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
    ssl = { rejectUnauthorized };
  }

  const config: DatabaseConfig = {
    connectionString:
      process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    ssl,
    maxPoolSize: 2,
    minPoolSize: 0,
  };

  runMigrations(config)
    .then(() => {
      console.log("Migration complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
}
