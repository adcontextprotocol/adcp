-- Replace migration 584's misleading per-response "settlement" vocabulary.
-- A dated pricing profile is a local estimate; provider-authoritative billing
-- remains an isolated-scope aggregate reconciliation outside this ledger.
--
-- This operator-only forward migration deliberately requires completely empty
-- custody tables. No paid matched-v4 attempt or admission is authorized, so
-- refusing to translate evidence is safer than relabelling it in place.
DO $matched_v4_585$
DECLARE old_shape BOOLEAN; transformed_shape BOOLEAN; attempts_count BIGINT;
        admissions_count BIGINT; runs_count BIGINT; valid BOOLEAN;
        existing_tables INTEGER; existing_functions INTEGER;
        existing_triggers INTEGER; existing_relations INTEGER;
        existing_attempt_guard_md5 TEXT;
        existing_append_guard_md5 TEXT; actual_shape_md5 TEXT;
        actual_function_md5 TEXT; actual_function_owner TEXT;
        actual_function_security_definer BOOLEAN; actual_function_config TEXT[];
        existing_trigger_shape_valid BOOLEAN; existing_constraint_trigger_shape_valid BOOLEAN;
        existing_relation_shape_valid BOOLEAN;
        existing_acl_valid BOOLEAN;
        unexpected_trigger_count INTEGER; shape_expected RECORD;
BEGIN
  IF current_user <> 'addie_matched_v4_operator'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_runtime' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR pg_catalog.pg_has_role('addie_matched_v4_runtime', 'addie_matched_v4_operator', 'member')
    -- The sealed static capabilities are leaves of the role graph. A static
    -- role that can SET or inherit an elevated parent has a hidden privilege
    -- path despite its own unprivileged role attributes.
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE edge.member IN ('addie_matched_v4_operator'::regrole,'addie_matched_v4_runtime'::regrole))
    -- The static roles are sealed custody capabilities, not merely names.
    -- The migration login is the one non-inheriting SET member of operator;
    -- runtime has exactly one inheriting, non-SET, non-admin app member.
    -- This rejects hidden operator bridges before an admission can attest.
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members edge WHERE edge.roleid='addie_matched_v4_operator'::regrole) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge JOIN pg_catalog.pg_roles member_role ON member_role.oid=edge.member WHERE edge.roleid='addie_matched_v4_operator'::regrole AND edge.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user) AND NOT edge.inherit_option AND edge.set_option AND NOT edge.admin_option AND member_role.rolcanlogin AND NOT member_role.rolinherit AND NOT member_role.rolsuper AND NOT member_role.rolcreatedb AND NOT member_role.rolcreaterole AND NOT member_role.rolreplication AND NOT member_role.rolbypassrls AND edge.grantor NOT IN (edge.roleid,edge.member,'addie_matched_v4_runtime'::regrole))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE edge.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user) AND edge.roleid<>'addie_matched_v4_operator'::regrole)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE edge.roleid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user))
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members edge WHERE edge.roleid='addie_matched_v4_runtime'::regrole) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge JOIN pg_catalog.pg_roles member_role ON member_role.oid=edge.member WHERE edge.roleid='addie_matched_v4_runtime'::regrole AND edge.inherit_option AND NOT edge.set_option AND NOT edge.admin_option AND member_role.rolcanlogin AND member_role.rolinherit AND NOT member_role.rolsuper AND NOT member_role.rolcreatedb AND NOT member_role.rolcreaterole AND NOT member_role.rolreplication AND NOT member_role.rolbypassrls AND edge.grantor NOT IN (edge.roleid,edge.member,'addie_matched_v4_operator'::regrole,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members bridge JOIN pg_catalog.pg_auth_members edge ON edge.member=bridge.member WHERE bridge.roleid='addie_matched_v4_runtime'::regrole AND edge.roleid<>'addie_matched_v4_runtime'::regrole)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members bridge JOIN pg_catalog.pg_auth_members edge ON edge.roleid=bridge.member WHERE bridge.roleid='addie_matched_v4_runtime'::regrole)
    -- Trigger enforcement is session-sensitive. A persisted replica-mode
    -- default on the sole runtime bridge would bypass custody guards and RI.
    OR current_setting('session_replication_role') <> 'origin'
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members bridge JOIN pg_catalog.pg_db_role_setting setting ON setting.setrole IN (0,bridge.member) CROSS JOIN LATERAL unnest(setting.setconfig) config WHERE bridge.roleid='addie_matched_v4_runtime'::regrole AND setting.setdatabase IN (0,(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())) AND split_part(config,'=',1)='session_replication_role' AND split_part(config,'=',2)<>'origin')
    OR pg_catalog.has_parameter_privilege('addie_matched_v4_runtime','session_replication_role','SET')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members bridge WHERE bridge.roleid='addie_matched_v4_runtime'::regrole AND pg_catalog.has_parameter_privilege(bridge.member,'session_replication_role','SET'))
    -- A runtime bridge must not retain an independent public-object or TOAST
    -- injection/read route outside the sealed static capability.
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members bridge WHERE bridge.roleid='addie_matched_v4_runtime'::regrole AND (NOT pg_catalog.has_schema_privilege(bridge.member,'public','USAGE') OR pg_catalog.has_schema_privilege(bridge.member,'public','CREATE') OR pg_catalog.has_schema_privilege(bridge.member,'pg_toast','USAGE') OR pg_catalog.has_schema_privilege(bridge.member,'pg_toast','CREATE'))) THEN
    RAISE EXCEPTION 'matched-v4 585 requires the externally provisioned separated operator/runtime roles';
  END IF;

  old_shape := to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)') IS NOT NULL
    AND to_regprocedure('public.addie_matched_v4_private_record_response_usage(text,text,text,text,bigint)') IS NULL;
  transformed_shape := to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)') IS NULL
    AND to_regprocedure('public.addie_matched_v4_private_record_response_usage(text,text,text,text,bigint)') IS NOT NULL;
  IF NOT old_shape AND NOT transformed_shape THEN
    RAISE EXCEPTION 'matched-v4 585 found a partial or tampered terminal-record API';
  END IF;
  -- READ COMMITTED obtains a fresh snapshot after the legacy transform's
  -- ACCESS EXCLUSIVE lock. REPEATABLE READ could retain a pre-lock empty
  -- snapshot and relabel a writer that committed while the lock waited.
  IF old_shape AND current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'matched-v4 585 legacy transformation requires READ COMMITTED isolation';
  END IF;

  -- The protected evaluator workflow takes this transaction lock on every
  -- bootstrap, retry, and admission path. A transformed retry takes the
  -- weakest relation lock that excludes table-shape DDL without blocking
  -- ordinary evaluator DML. A legacy-shape transform instead takes ACCESS
  -- EXCLUSIVE before its zero-evidence check: otherwise a pre-existing 584
  -- runtime transaction could commit evidence while ALTER waits.
  -- Function and ACL serialization depends on that trusted workflow.
  PERFORM pg_catalog.pg_advisory_xact_lock(584585);
  IF old_shape THEN
    LOCK TABLE public.addie_matched_v4_private_runs,
      public.addie_matched_v4_private_admissions,
      public.addie_matched_v4_private_attempts IN ACCESS EXCLUSIVE MODE;
  ELSE
    LOCK TABLE public.addie_matched_v4_private_runs,
      public.addie_matched_v4_private_admissions,
      public.addie_matched_v4_private_attempts IN ACCESS SHARE MODE;
  END IF;

  IF old_shape THEN
    -- Migration 584 deliberately fails closed on a retry. Repeat that full
    -- catalog attestation here before any ALTER or CREATE OR REPLACE: a
    -- forward migration must never repair an incomplete or altered old shape.
  SELECT count(*) INTO existing_tables FROM (VALUES
    (to_regclass('public.addie_matched_v4_private_runs')),
    (to_regclass('public.addie_matched_v4_private_admissions')),
    (to_regclass('public.addie_matched_v4_private_attempts'))
  ) AS expected(oid) WHERE oid IS NOT NULL;
  SELECT count(*) INTO existing_functions FROM (VALUES
    (to_regprocedure('public.addie_matched_v4_private_attempt_guard()')),
    (to_regprocedure('public.addie_matched_v4_private_append_only_guard()')),
    (to_regprocedure('public.addie_matched_v4_private_reserve(text,text,text,integer)')),
    (to_regprocedure('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)')),
    (to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)')),
    (to_regprocedure('public.addie_matched_v4_private_reconcile(text)')),
    (to_regprocedure('public.addie_matched_v4_private_halt(text,text)')),
    (to_regprocedure('public.addie_matched_v4_private_claim_admission(text,text,text)'))
  ) AS expected(oid) WHERE oid IS NOT NULL;
  -- Tables and their reviewed physical indexes are one exact namespace set.
  -- Counting every pg_class kind closes the otherwise invisible view,
  -- sequence, and partition shadow-object paths.
  SELECT count(*) INTO existing_relations
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname LIKE 'addie_matched_v4_private_%';
  SELECT NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('addie_matched_v4_private_runs','r'::"char"),
      ('addie_matched_v4_private_runs_pkey','i'::"char"),
      ('addie_matched_v4_private_admissions','r'::"char"),
      ('addie_matched_v4_private_admissions_pkey','i'::"char"),
      ('addie_matched_v4_private_admi_merge_sha_authority_manifest__key','i'::"char"),
      ('addie_matched_v4_private_attempts','r'::"char"),
      ('addie_matched_v4_private_attempts_pkey','i'::"char"),
      ('addie_matched_v4_private_attempts_reservation_id_ordinal_key','i'::"char")
    ) AS expected(name,relkind)
    WHERE to_regclass('public.' || expected.name) IS NULL
      OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) <> expected.relkind
      OR (SELECT c.relpersistence FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) <> 'p'
      OR (expected.relkind='r'::"char" AND (SELECT c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules OR c.relispartition FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)))
      OR (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) <> 'addie_matched_v4_operator'
      OR (expected.relkind='i'::"char" AND (SELECT c.relacl FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) IS NOT NULL)
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite r
    WHERE r.ev_class IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
      AND r.rulename <> '_RETURN'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
    WHERE r.ev_class NOT IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
      AND d.refobjid IN (
        SELECT c.oid FROM pg_catalog.pg_class c
        WHERE c.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
        UNION ALL
        SELECT c.reltoastrelid FROM pg_catalog.pg_class c
        WHERE c.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
          AND c.reltoastrelid <> 0
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits i
    WHERE i.inhrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
      OR i.inhparent IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
  ) INTO existing_relation_shape_valid;
  -- A foreign key is enforced by internal RI triggers rather than table DDL
  -- alone. Its constraint definition may still hash canonically after one is
  -- disabled, so retry attestation pins all involved trigger states too.
  -- Pin the complete RI-trigger structure, not merely enabled state. An
  -- incoming foreign key on an unrelated table creates extra internal
  -- triggers on these tables and must invalidate the sealed namespace.
  SELECT
    (SELECT count(*) FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint
      WHERE t.tgisinternal AND t.tgconstraint <> 0
        AND (c.conrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
          OR c.confrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))) = 4
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgisinternal AND t.tgconstraint <> 0
        AND (c.conrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
          OR c.confrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND NOT EXISTS (
          SELECT 1 FROM (VALUES
            ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_runs','RI_FKey_restrict_del',9),
            ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_runs','RI_FKey_noaction_upd',17),
            ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_attempts','RI_FKey_check_ins',5),
            ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_attempts','RI_FKey_check_upd',17)
          ) AS expected(constraint_name,source_table,target_table,trigger_table,procedure_name,trigger_type)
          WHERE c.conname=expected.constraint_name
            AND c.conrelid=to_regclass('public.' || expected.source_table)
            AND c.confrelid=to_regclass('public.' || expected.target_table)
            AND t.tgrelid=to_regclass('public.' || expected.trigger_table)
            AND p.pronamespace='pg_catalog'::regnamespace
            AND p.proname=expected.procedure_name
            AND t.tgtype=expected.trigger_type AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgargs=''::bytea
        )
    ) INTO existing_constraint_trigger_shape_valid;
  SELECT count(*) INTO existing_triggers FROM pg_catalog.pg_trigger
    WHERE NOT tgisinternal AND tgname IN (
      'addie_matched_v4_private_attempt_guard',
      'addie_matched_v4_private_runs_append_only_guard',
      'addie_matched_v4_private_admissions_append_only_guard',
      'addie_matched_v4_private_attempts_append_only_guard'
    );
  -- A retry must attest trigger identity and executable shape before any
  -- CREATE/DROP statement. Counting familiar names is not enough: a disabled
  -- guard, an inert WHEN clause, or an UPDATE-only lookalike would otherwise
  -- be "repaired" and conceal an interrupted or tampered custody boundary.
  SELECT
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgname = 'addie_matched_v4_private_attempt_guard'
        AND t.tgrelid = to_regclass('public.addie_matched_v4_private_attempts')
        AND p.oid = to_regprocedure('public.addie_matched_v4_private_attempt_guard()')
        -- ROW | BEFORE | INSERT | UPDATE | DELETE
        AND t.tgtype = 31 AND t.tgenabled = 'O' AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgargs=''::bytea
        AND NOT t.tgisinternal
    )
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES
        ('public.addie_matched_v4_private_runs'::text,
         'addie_matched_v4_private_runs_append_only_guard'::text),
        ('public.addie_matched_v4_private_admissions'::text,
         'addie_matched_v4_private_admissions_append_only_guard'::text),
        ('public.addie_matched_v4_private_attempts'::text,
         'addie_matched_v4_private_attempts_append_only_guard'::text)
      ) AS retry_expected(table_name, trigger_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgname = retry_expected.trigger_name
          AND t.tgrelid = to_regclass(retry_expected.table_name)
          AND p.oid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
          -- ROW | BEFORE | DELETE
          AND t.tgtype = 11 AND t.tgenabled = 'O' AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgargs=''::bytea
          AND NOT t.tgisinternal
      )
    ) INTO existing_trigger_shape_valid;
  -- The retry path has the same exact trigger-set requirement as the runtime
  -- attestation. A familiar set of names plus an extra mutable trigger is not
  -- a complete schema: it can rewrite a reservation or attempt before the
  -- reviewed guards run.
  SELECT count(*) INTO unexpected_trigger_count
  FROM pg_catalog.pg_trigger actual
  WHERE NOT actual.tgisinternal
    AND actual.tgrelid IN (
      to_regclass('public.addie_matched_v4_private_runs'),
      to_regclass('public.addie_matched_v4_private_admissions'),
      to_regclass('public.addie_matched_v4_private_attempts')
    )
    AND NOT (
      (actual.tgrelid = to_regclass('public.addie_matched_v4_private_attempts')
        AND actual.tgname = 'addie_matched_v4_private_attempt_guard'
        AND actual.tgfoid = to_regprocedure('public.addie_matched_v4_private_attempt_guard()')
        AND actual.tgtype = 31 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL AND actual.tgattr=''::int2vector AND actual.tgargs=''::bytea)
      OR
      (actual.tgrelid = to_regclass('public.addie_matched_v4_private_runs')
        AND actual.tgname = 'addie_matched_v4_private_runs_append_only_guard'
        AND actual.tgfoid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
        AND actual.tgtype = 11 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL AND actual.tgattr=''::int2vector AND actual.tgargs=''::bytea)
      OR
      (actual.tgrelid = to_regclass('public.addie_matched_v4_private_admissions')
        AND actual.tgname = 'addie_matched_v4_private_admissions_append_only_guard'
        AND actual.tgfoid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
        AND actual.tgtype = 11 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL AND actual.tgattr=''::int2vector AND actual.tgargs=''::bytea)
      OR
      (actual.tgrelid = to_regclass('public.addie_matched_v4_private_attempts')
        AND actual.tgname = 'addie_matched_v4_private_attempts_append_only_guard'
        AND actual.tgfoid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
        AND actual.tgtype = 11 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL AND actual.tgattr=''::int2vector AND actual.tgargs=''::bytea)
    );
  SELECT md5(pg_get_functiondef(to_regprocedure('public.addie_matched_v4_private_attempt_guard()')))
    INTO existing_attempt_guard_md5;
  SELECT md5(pg_get_functiondef(to_regprocedure('public.addie_matched_v4_private_append_only_guard()')))
    INTO existing_append_guard_md5;
  IF existing_tables <> 3 OR existing_relations <> 8
    OR (SELECT count(*) FROM pg_catalog.pg_class WHERE relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')) <> 14
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator') AND c.oid NOT IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_runs_pkey'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_admissions_pkey'),to_regclass('public.addie_matched_v4_private_admi_merge_sha_authority_manifest__key'),to_regclass('public.addie_matched_v4_private_attempts'),to_regclass('public.addie_matched_v4_private_attempts_pkey'),to_regclass('public.addie_matched_v4_private_attempts_reservation_id_ordinal_key')) AND c.oid NOT IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))))
    OR existing_relation_shape_valid IS NOT TRUE
    OR existing_functions <> 8 OR existing_triggers <> 4
    OR existing_constraint_trigger_shape_valid IS NOT TRUE
    OR (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'addie_matched_v4_private_%') <> 8
    OR (SELECT count(*) FROM pg_catalog.pg_proc WHERE proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')) <> 8
    OR unexpected_trigger_count <> 0
    OR existing_trigger_shape_valid IS NOT TRUE
    OR existing_attempt_guard_md5 <> 'cdba27677dbbbbdfa59db5988b1681fc'
    OR existing_append_guard_md5 <> 'b66c0828506e4785edf27b41190c3ed9' THEN
    RAISE EXCEPTION 'matched-v4 evaluator schema is partial or invalid; restore the externally administered schema before retrying migration 584';
  END IF;

  -- `CREATE TABLE IF NOT EXISTS` and `CREATE OR REPLACE FUNCTION` are not a
  -- repair mechanism. On retry, attest every reviewer-visible table component
  -- before touching any object: ordered columns/types/nullability/defaults,
  -- named constraints, and every physical index. This deliberately catches a
  -- lookalike relation, a missing CHECK, or an added index as malformed state.
  FOR shape_expected IN SELECT * FROM (VALUES
    ('addie_matched_v4_private_admissions', '4ed0c46ae7eaee829b967b8c8eeb1996'),
    ('addie_matched_v4_private_attempts', '985534c4e9f7d0d78e8fe6a885816926'),
    ('addie_matched_v4_private_runs', '16a018c611239801d31c7855ca8c1a28')
  ) AS shapes(name, shape_md5) LOOP
    SELECT md5((jsonb_build_object(
      'table', c.relname, 'relkind', c.relkind,
      'columns', (SELECT jsonb_agg(jsonb_build_object(
        'ordinal', a.attnum, 'name', a.attname,
        'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
        'notNull', a.attnotnull,
        'default', COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''),
        'collation', CASE WHEN a.attcollation=0 THEN NULL ELSE (SELECT n.nspname || '.' || co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation) END,
        'identity', a.attidentity, 'generated', a.attgenerated
      ) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_agg(jsonb_build_object(
        'name', x.conname, 'type', x.contype,
        'definition', pg_catalog.pg_get_constraintdef(x.oid, true)
      ) ORDER BY x.conname) FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),
      'indexes', (SELECT jsonb_agg(jsonb_build_object(
        'name', ci.relname,
        'definition', pg_catalog.pg_get_indexdef(i.indexrelid, 0, true)
      ) ORDER BY ci.relname) FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid)
    )::text)), pg_catalog.pg_get_userbyid(c.relowner)
    INTO actual_shape_md5, actual_function_owner
    FROM pg_catalog.pg_class c
    WHERE c.oid = to_regclass('public.' || shape_expected.name);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass('public.' || shape_expected.name) AND a.attnum>0 AND a.attisdropped)
      OR actual_shape_md5 IS DISTINCT FROM shape_expected.shape_md5
      OR actual_function_owner <> 'addie_matched_v4_operator' THEN
      RAISE EXCEPTION 'matched-v4 evaluator table shape is malformed; refuse bootstrap retry';
    END IF;
  END LOOP;

  -- Pin all eight function definitions on a retry. The six callable APIs
  -- must be SECURITY DEFINER with exactly SET search_path = pg_catalog; the
  -- trigger guards must remain invoker functions without configuration.
  FOR shape_expected IN SELECT * FROM (VALUES
    ('public.addie_matched_v4_private_attempt_guard()', 'cdba27677dbbbbdfa59db5988b1681fc', false),
    ('public.addie_matched_v4_private_append_only_guard()', 'b66c0828506e4785edf27b41190c3ed9', false),
    ('public.addie_matched_v4_private_reserve(text,text,text,integer)', 'a246e0fa7b05238e52f384138ec99047', true),
    ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)', '85c35d25f690969ed336fe7a9e30115d', true),
    ('public.addie_matched_v4_private_settle(text,text,text,text,bigint)', 'b0a13ae1f175fa97ee751b70da68e378', true),
    ('public.addie_matched_v4_private_reconcile(text)', 'd0fc5263623f248ba1d1957f1127fd68', true),
    ('public.addie_matched_v4_private_halt(text,text)', '2d35d780d2279dc302db1bc27967c8f9', true),
    ('public.addie_matched_v4_private_claim_admission(text,text,text)', '4db729c5722fd978efebf52ace62bb6a', true)
  ) AS functions(signature, definition_md5, security_definer) LOOP
    SELECT md5(pg_catalog.pg_get_functiondef(p.oid)),
      pg_catalog.pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO actual_function_md5, actual_function_owner,
      actual_function_security_definer, actual_function_config
    FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure(shape_expected.signature);
    IF actual_function_md5 IS DISTINCT FROM shape_expected.definition_md5
      OR actual_function_owner <> 'addie_matched_v4_operator'
      OR actual_function_security_definer IS DISTINCT FROM shape_expected.security_definer
      OR (shape_expected.security_definer AND actual_function_config IS DISTINCT FROM ARRAY['search_path=pg_catalog'])
      OR (NOT shape_expected.security_definer AND actual_function_config IS NOT NULL) THEN
      RAISE EXCEPTION 'matched-v4 evaluator function definition is malformed; refuse bootstrap retry';
    END IF;
  END LOOP;

  -- A complete retry is a read-only attestation, not an opportunity to
  -- silently repair grants.  The runtime API and PUBLIC revocations are as
  -- much evaluator custody as the relation definitions: accepting a direct
  -- table grant or a PUBLIC callable function would make a retry conceal a
  -- production bypass.
  SELECT
    pg_catalog.has_schema_privilege('addie_matched_v4_operator', 'public', 'USAGE')
    AND pg_catalog.has_schema_privilege('addie_matched_v4_operator', 'public', 'CREATE')
    AND pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'public', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'public', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'pg_toast', 'USAGE,CREATE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type='CREATE'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND (acl.grantee<>c.relowner OR acl.grantor<>c.relowner OR acl.is_grantable)
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner)))) <> 7
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES
        (to_regclass('public.addie_matched_v4_private_runs')),
        (to_regclass('public.addie_matched_v4_private_admissions')),
        (to_regclass('public.addie_matched_v4_private_attempts'))
      ) AS tables(oid),
      unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS privilege
      WHERE pg_catalog.has_table_privilege('addie_matched_v4_runtime', tables.oid, privilege)
         OR EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(
             COALESCE((SELECT c.relacl FROM pg_catalog.pg_class c WHERE c.oid = tables.oid),
                      pg_catalog.acldefault('r', (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = tables.oid)))
           ) acl WHERE acl.grantee = 0
         )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc p
      WHERE p.oid IN (
        to_regprocedure('public.addie_matched_v4_private_attempt_guard()'),
        to_regprocedure('public.addie_matched_v4_private_append_only_guard()'),
        to_regprocedure('public.addie_matched_v4_private_reserve(text,text,text,integer)'),
        to_regprocedure('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)'),
        to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)'),
        to_regprocedure('public.addie_matched_v4_private_reconcile(text)'),
        to_regprocedure('public.addie_matched_v4_private_halt(text,text)'),
        to_regprocedure('public.addie_matched_v4_private_claim_admission(text,text,text)')
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES
        (to_regclass('public.addie_matched_v4_private_runs')),
        (to_regclass('public.addie_matched_v4_private_admissions')),
        (to_regclass('public.addie_matched_v4_private_attempts'))
      ) AS tables(oid)
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        (SELECT c.relacl FROM pg_catalog.pg_class c WHERE c.oid=tables.oid),
        pg_catalog.acldefault('r', (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid=tables.oid))
      )) acl
      WHERE acl.grantee <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')
        OR acl.grantor <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')
        OR acl.is_grantable
    )
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        (to_regclass('public.addie_matched_v4_private_runs')),
        (to_regclass('public.addie_matched_v4_private_admissions')),
        (to_regclass('public.addie_matched_v4_private_attempts'))
      ) AS tables(oid)
      WHERE (SELECT count(*) FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid=tables.oid) <> 7
    )
    -- Table ACLs do not cover per-column grants. No evaluator column may
    -- have an explicit ACL, including one to the otherwise unprivileged
    -- runtime role.
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
        AND a.attnum > 0 AND NOT a.attisdropped AND (
          a.attacl IS NOT NULL
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'SELECT')
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'INSERT')
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'UPDATE')
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'REFERENCES')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (
        to_regprocedure('public.addie_matched_v4_private_attempt_guard()'),
        to_regprocedure('public.addie_matched_v4_private_append_only_guard()'),
        to_regprocedure('public.addie_matched_v4_private_reserve(text,text,text,integer)'),
        to_regprocedure('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)'),
        to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)'),
        to_regprocedure('public.addie_matched_v4_private_reconcile(text)'),
        to_regprocedure('public.addie_matched_v4_private_halt(text,text)'),
        to_regprocedure('public.addie_matched_v4_private_claim_admission(text,text,text)')
      ) AND (
        acl.grantee NOT IN (
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator'),
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_runtime')
        ) OR acl.grantor <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')
          OR acl.is_grantable
      )
    )
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_reserve(text,text,text,integer)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_reconcile(text)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_halt(text,text)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_claim_admission(text,text,text)'), 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_attempt_guard()'), 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_append_only_guard()'), 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('public.addie_matched_v4_private_attempt_guard()',false),
        ('public.addie_matched_v4_private_append_only_guard()',false),
        ('public.addie_matched_v4_private_reserve(text,text,text,integer)',true),
        ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)',true),
        ('public.addie_matched_v4_private_settle(text,text,text,text,bigint)',true),
        ('public.addie_matched_v4_private_reconcile(text)',true),
        ('public.addie_matched_v4_private_halt(text,text)',true),
        ('public.addie_matched_v4_private_claim_admission(text,text,text)',true)
      ) AS expected(signature,runtime_execute)
      WHERE (SELECT count(*) FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE p.oid=to_regprocedure(expected.signature)) <> CASE WHEN expected.runtime_execute THEN 2 ELSE 1 END
    )
  INTO existing_acl_valid;
  IF existing_acl_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'matched-v4 evaluator ACL is malformed; refuse bootstrap retry';
  END IF;

    SELECT count(*) INTO attempts_count FROM public.addie_matched_v4_private_attempts;
    SELECT count(*) INTO admissions_count FROM public.addie_matched_v4_private_admissions;
    SELECT count(*) INTO runs_count FROM public.addie_matched_v4_private_runs;
    IF attempts_count <> 0 OR admissions_count <> 0 OR runs_count <> 0 THEN
      RAISE EXCEPTION 'matched-v4 585 refuses to relabel existing custody evidence (attempts %, admissions %, runs %)', attempts_count, admissions_count, runs_count;
    END IF;

    ALTER TABLE public.addie_matched_v4_private_attempts
      DROP CONSTRAINT addie_matched_v4_private_attempts_status_check,
      DROP CONSTRAINT addie_matched_v4_private_attempts_cost_microdollars_check,
      DROP CONSTRAINT addie_matched_v4_private_attempts_check;
    ALTER TABLE public.addie_matched_v4_private_attempts
      RENAME COLUMN cost_microdollars TO estimated_cost_microdollars;
    ALTER TABLE public.addie_matched_v4_private_attempts
      RENAME COLUMN settled_at TO terminal_recorded_at;
    ALTER TABLE public.addie_matched_v4_private_attempts
      ADD CONSTRAINT addie_matched_v4_private_attempts_status_check
        CHECK (status IN ('intent_recorded', 'response_usage_recorded', 'unknown_exposure')),
      ADD CONSTRAINT addie_matched_v4_private_attempts_estimated_cost_check
        CHECK (estimated_cost_microdollars >= 0),
      ADD CONSTRAINT addie_matched_v4_private_attempts_terminal_recording_check
        CHECK ((status = 'intent_recorded' AND response_sha256 IS NULL AND estimated_cost_microdollars IS NULL AND terminal_recorded_at IS NULL)
          OR (status = 'response_usage_recorded' AND response_sha256 IS NOT NULL AND estimated_cost_microdollars IS NOT NULL AND terminal_recorded_at IS NOT NULL)
          OR (status = 'unknown_exposure' AND response_sha256 IS NULL AND estimated_cost_microdollars IS NULL AND terminal_recorded_at IS NOT NULL));

    CREATE OR REPLACE FUNCTION public.addie_matched_v4_private_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $attempt_source$DECLARE run_status TEXT; run_cap INTEGER; already_count INTEGER;
BEGIN
  -- Recording a response/usage or unknown exposure remains legal after halt:
  -- it closes an already ledgered intent and never authorizes a dispatch.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'intent_recorded' OR NEW.status NOT IN ('response_usage_recorded', 'unknown_exposure')
      OR NEW.reservation_id <> OLD.reservation_id OR NEW.attempt_id <> OLD.attempt_id
      OR NEW.assignment_id <> OLD.assignment_id OR NEW.ordinal <> OLD.ordinal
      OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.dispatched_at <> OLD.dispatched_at
      OR NEW.service_tier <> OLD.service_tier OR NEW.pricing_profile_id <> OLD.pricing_profile_id
      OR NEW.pricing_profile_sha256 <> OLD.pricing_profile_sha256 THEN
      RAISE EXCEPTION 'matched-v4 attempt is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'matched-v4 attempt custody is append-only'; END IF;
  SELECT status, dispatch_cap INTO run_status, run_cap FROM public.addie_matched_v4_private_runs WHERE reservation_id = NEW.reservation_id FOR UPDATE;
  IF run_status IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'matched-v4 run is not dispatchable'; END IF;
  SELECT count(*) INTO already_count FROM public.addie_matched_v4_private_attempts WHERE reservation_id = NEW.reservation_id;
  IF already_count >= run_cap THEN RAISE EXCEPTION 'matched-v4 dispatch cap exhausted'; END IF;
  RETURN NEW;
END$attempt_source$;
    REVOKE ALL ON FUNCTION public.addie_matched_v4_private_settle(TEXT,TEXT,TEXT,TEXT,BIGINT) FROM PUBLIC, addie_matched_v4_runtime;
    DROP FUNCTION public.addie_matched_v4_private_settle(TEXT,TEXT,TEXT,TEXT,BIGINT);
    CREATE FUNCTION public.addie_matched_v4_private_record_response_usage(TEXT,TEXT,TEXT,TEXT,BIGINT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $record_source$BEGIN
  UPDATE public.addie_matched_v4_private_attempts
    SET status=$3,response_sha256=$4,estimated_cost_microdollars=$5,terminal_recorded_at=clock_timestamp()
    WHERE reservation_id=$1 AND attempt_id=$2 AND status='intent_recorded';
  RETURN FOUND;
END$record_source$;
    CREATE OR REPLACE FUNCTION public.addie_matched_v4_private_reconcile(TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $reconcile_source$DECLARE exists_run BOOLEAN;
BEGIN
  UPDATE public.addie_matched_v4_private_attempts
    SET status='unknown_exposure',response_sha256=NULL,estimated_cost_microdollars=NULL,terminal_recorded_at=clock_timestamp()
    WHERE reservation_id=$1 AND status='intent_recorded';
  SELECT EXISTS(SELECT 1 FROM public.addie_matched_v4_private_runs WHERE reservation_id=$1) INTO exists_run;
  RETURN exists_run;
END$reconcile_source$;
    REVOKE ALL ON FUNCTION public.addie_matched_v4_private_attempt_guard(), public.addie_matched_v4_private_append_only_guard(), public.addie_matched_v4_private_reserve(TEXT,TEXT,TEXT,INTEGER), public.addie_matched_v4_private_intent(TEXT,TEXT,TEXT,INTEGER,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT), public.addie_matched_v4_private_record_response_usage(TEXT,TEXT,TEXT,TEXT,BIGINT), public.addie_matched_v4_private_reconcile(TEXT), public.addie_matched_v4_private_halt(TEXT,TEXT), public.addie_matched_v4_private_claim_admission(TEXT,TEXT,TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.addie_matched_v4_private_reserve(TEXT,TEXT,TEXT,INTEGER), public.addie_matched_v4_private_intent(TEXT,TEXT,TEXT,INTEGER,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT), public.addie_matched_v4_private_record_response_usage(TEXT,TEXT,TEXT,TEXT,BIGINT), public.addie_matched_v4_private_reconcile(TEXT), public.addie_matched_v4_private_halt(TEXT,TEXT), public.addie_matched_v4_private_claim_admission(TEXT,TEXT,TEXT) TO addie_matched_v4_runtime;
  END IF;

  -- On transformed schemas this is a read-only, exact catalog attestation.
  -- It is deliberately run again in the admission transaction by the protected
  -- workflow: no admission may be inserted after an unchecked schema change.
  SELECT
    pg_catalog.has_schema_privilege('addie_matched_v4_operator', 'public', 'USAGE')
    AND pg_catalog.has_schema_privilege('addie_matched_v4_operator', 'public', 'CREATE')
    AND pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'public', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'public', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege('addie_matched_v4_runtime', 'pg_toast', 'USAGE,CREATE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type='CREATE'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND (acl.grantee<>c.relowner OR acl.grantor<>c.relowner OR acl.is_grantable)
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner)))) <> 7
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    )
    -- The three reviewed custody tables and their five physical indexes are
    -- the complete prefixed relation set. This also rejects shadow views,
    -- sequences, and partitions before any admission can be inserted.
    AND (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'addie_matched_v4_private_%') = 8
    -- The dedicated operator owns only the eight reviewed relations plus the
    -- three automatically-created TOAST relations and their indexes. This
    -- closes arbitrary-name views and helper APIs that could otherwise route
    -- around the prefixed custody-object inventory.
    AND (SELECT count(*) FROM pg_catalog.pg_class WHERE relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')) = 14
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator') AND c.oid NOT IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_runs_pkey'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_admissions_pkey'),to_regclass('public.addie_matched_v4_private_admi_merge_sha_authority_manifest__key'),to_regclass('public.addie_matched_v4_private_attempts'),to_regclass('public.addie_matched_v4_private_attempts_pkey'),to_regclass('public.addie_matched_v4_private_attempts_reservation_id_ordinal_key')) AND c.oid NOT IN (SELECT t.reltoastrelid FROM pg_catalog.pg_class t WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.reltoastrelid=i.indrelid WHERE t.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))))
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('addie_matched_v4_private_runs','r'::"char"),
        ('addie_matched_v4_private_runs_pkey','i'::"char"),
        ('addie_matched_v4_private_admissions','r'::"char"),
        ('addie_matched_v4_private_admissions_pkey','i'::"char"),
        ('addie_matched_v4_private_admi_merge_sha_authority_manifest__key','i'::"char"),
        ('addie_matched_v4_private_attempts','r'::"char"),
        ('addie_matched_v4_private_attempts_pkey','i'::"char"),
        ('addie_matched_v4_private_attempts_reservation_id_ordinal_key','i'::"char")
      ) AS expected(name,relkind)
      WHERE to_regclass('public.' || expected.name) IS NULL
        OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) <> expected.relkind
        OR (SELECT c.relpersistence FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) <> 'p'
        OR (expected.relkind='r'::"char" AND (SELECT c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules OR c.relispartition FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)))
        OR (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) <> 'addie_matched_v4_operator'
        OR (expected.relkind='i'::"char" AND (SELECT c.relacl FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)) IS NOT NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
      WHERE p.polrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_rewrite r
      WHERE r.ev_class IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
        AND r.rulename <> '_RETURN'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_rewrite r
      JOIN pg_catalog.pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
      WHERE r.ev_class NOT IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
      AND d.refobjid IN (
        SELECT c.oid FROM pg_catalog.pg_class c
        WHERE c.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
        UNION ALL
        SELECT c.reltoastrelid FROM pg_catalog.pg_class c
        WHERE c.oid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
          AND c.reltoastrelid <> 0
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits i
      WHERE i.inhrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
        OR i.inhparent IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('addie_matched_v4_private_runs'),
        ('addie_matched_v4_private_admissions'),
        ('addie_matched_v4_private_attempts')
      ) AS expected(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass('public.' || expected.name)
      WHERE c.oid IS NULL
        OR pg_catalog.pg_get_userbyid(c.relowner) <> 'addie_matched_v4_operator'
        OR EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
          WHERE acl.grantee <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')
            OR acl.grantor <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')
            OR acl.is_grantable
        )
        OR (SELECT count(*) FROM pg_catalog.pg_class source CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(source.relacl,pg_catalog.acldefault('r',source.relowner))) acl WHERE source.oid=c.oid) <> 7
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
        AND a.attnum > 0 AND NOT a.attisdropped AND (
          a.attacl IS NOT NULL
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'SELECT')
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'INSERT')
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'UPDATE')
          OR pg_catalog.has_column_privilege('addie_matched_v4_runtime',a.attrelid,a.attnum,'REFERENCES')
        )
    )
    -- Full canonical catalog projection: every ordered column (including
    -- collation and identity/generated state), named constraint, and physical
    -- index is pinned for all three relations; dropped slots are rejected.
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('addie_matched_v4_private_admissions', '4ed0c46ae7eaee829b967b8c8eeb1996'),
        ('addie_matched_v4_private_attempts', '8dc693482e69a981110ffa1c547b1f69'),
        ('addie_matched_v4_private_runs', '16a018c611239801d31c7855ca8c1a28')
      ) AS expected(name, shape_md5)
      WHERE expected.shape_md5 IS DISTINCT FROM (
        SELECT md5((jsonb_build_object(
          'table', c.relname, 'relkind', c.relkind,
          'columns', (SELECT jsonb_agg(jsonb_build_object(
            'ordinal', a.attnum, 'name', a.attname,
            'type', pg_catalog.format_type(a.atttypid,a.atttypmod),
            'notNull', a.attnotnull,
            'default', COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''),
            'collation', CASE WHEN a.attcollation=0 THEN NULL ELSE (SELECT n.nspname || '.' || co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation) END,
            'identity', a.attidentity, 'generated', a.attgenerated
          ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
            LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
          'constraints', (SELECT jsonb_agg(jsonb_build_object(
            'name', x.conname, 'type', x.contype,
            'definition', pg_catalog.pg_get_constraintdef(x.oid,true)
          ) ORDER BY x.conname) FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),
          'indexes', (SELECT jsonb_agg(jsonb_build_object(
            'name', ci.relname, 'definition', pg_catalog.pg_get_indexdef(i.indexrelid,0,true)
          ) ORDER BY ci.relname) FROM pg_catalog.pg_index i
            JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid)
        )::text)) FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.' || expected.name)
      )
    )
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) AND a.attnum>0 AND a.attisdropped)
    -- The eight public functions are an exact allow-list. NULL OIDs are
    -- rejected before any catalog predicate, so a missing guard cannot vanish
    -- through SQL three-valued logic.
    AND (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'addie_matched_v4_private_%') = 8
    AND (SELECT count(*) FROM pg_catalog.pg_proc WHERE proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')) = 8
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('public.addie_matched_v4_private_attempt_guard()',false),
        ('public.addie_matched_v4_private_append_only_guard()',false),
        ('public.addie_matched_v4_private_reserve(text,text,text,integer)',true),
        ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)',true),
        ('public.addie_matched_v4_private_record_response_usage(text,text,text,text,bigint)',true),
        ('public.addie_matched_v4_private_reconcile(text)',true),
        ('public.addie_matched_v4_private_halt(text,text)',true),
        ('public.addie_matched_v4_private_claim_admission(text,text,text)',true)
      ) AS expected(signature,security_definer)
      WHERE to_regprocedure(expected.signature) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
            AND pg_catalog.pg_get_userbyid(p.proowner)='addie_matched_v4_operator'
            AND p.prosecdef=expected.security_definer
            AND (CASE WHEN expected.security_definer THEN p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog'] ELSE p.proconfig IS NULL END)
        )
    )
    AND to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)') IS NULL
    -- Full function definitions are pinned, including both guards and each
    -- SECURITY DEFINER body; metadata is checked separately above.
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('public.addie_matched_v4_private_attempt_guard()', 'ee4c62ffa52a33ee8144416274051bc6'),
        ('public.addie_matched_v4_private_append_only_guard()', 'b66c0828506e4785edf27b41190c3ed9'),
        ('public.addie_matched_v4_private_reserve(text,text,text,integer)', 'a246e0fa7b05238e52f384138ec99047'),
        ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)', '85c35d25f690969ed336fe7a9e30115d'),
        ('public.addie_matched_v4_private_record_response_usage(text,text,text,text,bigint)', '0d8ab008dd3d5d3354c528324432dc40'),
        ('public.addie_matched_v4_private_reconcile(text)', '87d8997b5c7408461244e7bd740d044f'),
        ('public.addie_matched_v4_private_halt(text,text)', '2d35d780d2279dc302db1bc27967c8f9'),
        ('public.addie_matched_v4_private_claim_admission(text,text,text)', '4db729c5722fd978efebf52ace62bb6a')
      ) AS expected(signature,definition_md5)
      WHERE to_regprocedure(expected.signature) IS NULL
        OR expected.definition_md5 IS DISTINCT FROM (
          SELECT md5(pg_catalog.pg_get_functiondef(to_regprocedure(expected.signature)))
        )
    )
    -- Runtime has EXECUTE only on the six custody APIs. No PUBLIC or other
    -- role ACL may create another route.
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('public.addie_matched_v4_private_attempt_guard()',false),
        ('public.addie_matched_v4_private_append_only_guard()',false),
        ('public.addie_matched_v4_private_reserve(text,text,text,integer)',true),
        ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)',true),
        ('public.addie_matched_v4_private_record_response_usage(text,text,text,text,bigint)',true),
        ('public.addie_matched_v4_private_reconcile(text)',true),
        ('public.addie_matched_v4_private_halt(text,text)',true),
        ('public.addie_matched_v4_private_claim_admission(text,text,text)',true)
      ) AS expected(signature,runtime_execute)
      WHERE to_regprocedure(expected.signature) IS NULL
        OR pg_catalog.has_function_privilege('addie_matched_v4_runtime',expected.signature,'EXECUTE') <> expected.runtime_execute
        OR (SELECT count(*) FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE p.oid=to_regprocedure(expected.signature)) <> CASE WHEN expected.runtime_execute THEN 2 ELSE 1 END
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc p
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
          WHERE p.oid=to_regprocedure(expected.signature) AND (
            (acl.grantee <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')
              AND acl.grantee <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_runtime'))
            OR acl.grantor <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='addie_matched_v4_operator')
            OR acl.is_grantable
          )
        )
    )
    -- Canonical enabled, unconditional trigger shapes, with no extras.
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('addie_matched_v4_private_attempts','addie_matched_v4_private_attempt_guard','public.addie_matched_v4_private_attempt_guard()',31),
        ('addie_matched_v4_private_runs','addie_matched_v4_private_runs_append_only_guard','public.addie_matched_v4_private_append_only_guard()',11),
        ('addie_matched_v4_private_admissions','addie_matched_v4_private_admissions_append_only_guard','public.addie_matched_v4_private_append_only_guard()',11),
        ('addie_matched_v4_private_attempts','addie_matched_v4_private_attempts_append_only_guard','public.addie_matched_v4_private_append_only_guard()',11)
      ) AS expected(table_name,trigger_name,procedure_signature,trigger_type)
      WHERE to_regclass('public.' || expected.table_name) IS NULL
        OR to_regprocedure(expected.procedure_signature) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid=to_regclass('public.' || expected.table_name)
            AND t.tgname=expected.trigger_name AND t.tgfoid=to_regprocedure(expected.procedure_signature)
            AND t.tgtype=expected.trigger_type AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgargs=''::bytea AND NOT t.tgisinternal
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger actual
      WHERE NOT actual.tgisinternal
        AND actual.tgrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts'))
        AND NOT EXISTS (
          SELECT 1 FROM (VALUES
            ('addie_matched_v4_private_attempts','addie_matched_v4_private_attempt_guard','public.addie_matched_v4_private_attempt_guard()',31),
            ('addie_matched_v4_private_runs','addie_matched_v4_private_runs_append_only_guard','public.addie_matched_v4_private_append_only_guard()',11),
            ('addie_matched_v4_private_admissions','addie_matched_v4_private_admissions_append_only_guard','public.addie_matched_v4_private_append_only_guard()',11),
            ('addie_matched_v4_private_attempts','addie_matched_v4_private_attempts_append_only_guard','public.addie_matched_v4_private_append_only_guard()',11)
          ) AS expected(table_name,trigger_name,procedure_signature,trigger_type)
          WHERE actual.tgrelid=to_regclass('public.' || expected.table_name)
            AND actual.tgname=expected.trigger_name AND actual.tgfoid=to_regprocedure(expected.procedure_signature)
            AND actual.tgtype=expected.trigger_type AND actual.tgenabled='O' AND actual.tgqual IS NULL AND actual.tgattr=''::int2vector AND actual.tgargs=''::bytea
        )
    )
    -- Constraint-backed internal RI triggers have an exact enabled structure.
    -- This rejects disabled enforcement and incoming FKs that would add
    -- internal triggers to an otherwise unchanged custody relation.
    AND (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint
      WHERE t.tgisinternal AND t.tgconstraint <> 0 AND (c.conrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) OR c.confrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))) = 4
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgisinternal AND t.tgconstraint <> 0 AND (c.conrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')) OR c.confrelid IN (to_regclass('public.addie_matched_v4_private_runs'),to_regclass('public.addie_matched_v4_private_admissions'),to_regclass('public.addie_matched_v4_private_attempts')))
        AND NOT EXISTS (SELECT 1 FROM (VALUES
          ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_runs','RI_FKey_restrict_del',9),
          ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_runs','RI_FKey_noaction_upd',17),
          ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_attempts','RI_FKey_check_ins',5),
          ('addie_matched_v4_private_attempts_reservation_id_fkey','addie_matched_v4_private_attempts','addie_matched_v4_private_runs','addie_matched_v4_private_attempts','RI_FKey_check_upd',17)
        ) AS expected(constraint_name,source_table,target_table,trigger_table,procedure_name,trigger_type)
        WHERE c.conname=expected.constraint_name AND c.conrelid=to_regclass('public.' || expected.source_table) AND c.confrelid=to_regclass('public.' || expected.target_table) AND t.tgrelid=to_regclass('public.' || expected.trigger_table) AND p.pronamespace='pg_catalog'::regnamespace AND p.proname=expected.procedure_name AND t.tgtype=expected.trigger_type AND t.tgenabled='O' AND t.tgqual IS NULL)
    )
  INTO valid;
  IF valid IS NOT TRUE THEN
    RAISE EXCEPTION 'matched-v4 585 transformed custody schema is partial or tampered';
  END IF;
END
$matched_v4_585$;
