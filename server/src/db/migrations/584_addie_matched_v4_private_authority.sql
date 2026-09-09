-- Prospective evaluator-only custody. No production Addie table references this ledger.
--
-- Prerequisite administered outside this application migration: the DBA must
-- provision NOLOGIN/NOINHERIT roles addie_matched_v4_operator and
-- addie_matched_v4_runtime, grant the application principal membership only
-- in the latter, and run this migration with current_user set to the former.
-- The application migration path fails closed rather than provisioning or
-- assuming either role itself.
DO $$
DECLARE operator_can_login BOOLEAN; operator_inherits BOOLEAN;
        runtime_can_login BOOLEAN; runtime_inherits BOOLEAN;
BEGIN
  SELECT rolcanlogin, rolinherit INTO operator_can_login, operator_inherits
    FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_operator';
  SELECT rolcanlogin, rolinherit INTO runtime_can_login, runtime_inherits
    FROM pg_catalog.pg_roles WHERE rolname = 'addie_matched_v4_runtime';
  IF operator_can_login IS NULL OR runtime_can_login IS NULL
    OR operator_can_login OR operator_inherits OR runtime_can_login OR runtime_inherits
    OR current_user <> 'addie_matched_v4_operator'
    OR pg_catalog.pg_has_role('addie_matched_v4_runtime', 'addie_matched_v4_operator', 'member')
    OR NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'matched-v4 requires externally provisioned, separated operator/runtime roles';
  END IF;
END $$;

-- A retry may start only from a completely absent evaluator schema or a
-- complete, already-attested one. A partly-created schema is evidence of an
-- interrupted/manual migration; leave it untouched and require the operator
-- to restore it from the reviewed migration rather than guessing at repair.
DO $$
DECLARE existing_tables INTEGER; existing_functions INTEGER;
        existing_triggers INTEGER; existing_attempt_guard_md5 TEXT;
        existing_append_guard_md5 TEXT; actual_shape_md5 TEXT;
        actual_function_md5 TEXT; actual_function_owner TEXT;
        actual_function_security_definer BOOLEAN; actual_function_config TEXT[];
        existing_trigger_shape_valid BOOLEAN; existing_acl_valid BOOLEAN;
        unexpected_trigger_count INTEGER;
        expected RECORD;
BEGIN
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
        AND t.tgtype = 31 AND t.tgenabled = 'O' AND t.tgqual IS NULL
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
          AND t.tgtype = 11 AND t.tgenabled = 'O' AND t.tgqual IS NULL
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
        AND actual.tgtype = 31 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL)
      OR
      (actual.tgrelid = to_regclass('public.addie_matched_v4_private_runs')
        AND actual.tgname = 'addie_matched_v4_private_runs_append_only_guard'
        AND actual.tgfoid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
        AND actual.tgtype = 11 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL)
      OR
      (actual.tgrelid = to_regclass('public.addie_matched_v4_private_admissions')
        AND actual.tgname = 'addie_matched_v4_private_admissions_append_only_guard'
        AND actual.tgfoid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
        AND actual.tgtype = 11 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL)
      OR
      (actual.tgrelid = to_regclass('public.addie_matched_v4_private_attempts')
        AND actual.tgname = 'addie_matched_v4_private_attempts_append_only_guard'
        AND actual.tgfoid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
        AND actual.tgtype = 11 AND actual.tgenabled = 'O' AND actual.tgqual IS NULL)
    );
  IF existing_tables = 0 AND existing_functions = 0 AND existing_triggers = 0 THEN
    PERFORM pg_catalog.set_config('addie_matched_v4.create_schema', 'true', true);
    RETURN;
  END IF;
  SELECT md5(pg_get_functiondef(to_regprocedure('public.addie_matched_v4_private_attempt_guard()')))
    INTO existing_attempt_guard_md5;
  SELECT md5(pg_get_functiondef(to_regprocedure('public.addie_matched_v4_private_append_only_guard()')))
    INTO existing_append_guard_md5;
  IF existing_tables <> 3 OR existing_functions <> 8 OR existing_triggers <> 4
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
  FOR expected IN SELECT * FROM (VALUES
    ('addie_matched_v4_private_admissions', '590e930adc4088aa7edb583a731c65a5'),
    ('addie_matched_v4_private_attempts', '2cdfc41ada3a7ecb2969b66588de78cd'),
    ('addie_matched_v4_private_runs', 'ac7f2cbd58af49f5fcaca7dec746ccac')
  ) AS shapes(name, shape_md5) LOOP
    SELECT md5((jsonb_build_object(
      'table', c.relname, 'relkind', c.relkind,
      'columns', (SELECT jsonb_agg(jsonb_build_object(
        'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
        'notNull', a.attnotnull,
        'default', COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
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
    WHERE c.oid = to_regclass('public.' || expected.name);
    IF actual_shape_md5 IS DISTINCT FROM expected.shape_md5
      OR actual_function_owner <> 'addie_matched_v4_operator' THEN
      RAISE EXCEPTION 'matched-v4 evaluator table shape is malformed; refuse bootstrap retry';
    END IF;
  END LOOP;

  -- Pin all eight function definitions on a retry. The six callable APIs
  -- must be SECURITY DEFINER with exactly SET search_path = pg_catalog; the
  -- trigger guards must remain invoker functions without configuration.
  FOR expected IN SELECT * FROM (VALUES
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
    WHERE p.oid = to_regprocedure(expected.signature);
    IF actual_function_md5 IS DISTINCT FROM expected.definition_md5
      OR actual_function_owner <> 'addie_matched_v4_operator'
      OR actual_function_security_definer IS DISTINCT FROM expected.security_definer
      OR (expected.security_definer AND actual_function_config IS DISTINCT FROM ARRAY['search_path=pg_catalog'])
      OR (NOT expected.security_definer AND actual_function_config IS NOT NULL) THEN
      RAISE EXCEPTION 'matched-v4 evaluator function definition is malformed; refuse bootstrap retry';
    END IF;
  END LOOP;

  -- A complete retry is a read-only attestation, not an opportunity to
  -- silently repair grants.  The runtime API and PUBLIC revocations are as
  -- much evaluator custody as the relation definitions: accepting a direct
  -- table grant or a PUBLIC callable function would make a retry conceal a
  -- production bypass.
  SELECT
    NOT EXISTS (
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
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_reserve(text,text,text,integer)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_settle(text,text,text,text,bigint)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_reconcile(text)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_halt(text,text)'), 'EXECUTE')
    AND pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_claim_admission(text,text,text)'), 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_attempt_guard()'), 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('addie_matched_v4_runtime', to_regprocedure('public.addie_matched_v4_private_append_only_guard()'), 'EXECUTE')
  INTO existing_acl_valid;
  IF existing_acl_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'matched-v4 evaluator ACL is malformed; refuse bootstrap retry';
  END IF;
  PERFORM pg_catalog.set_config('addie_matched_v4.create_schema', 'false', true);
END $$;

-- The statements below run only for a wholly absent schema.  On a complete
-- retry the preflight above has already attested every object and ACL, and
-- this dynamic block is a genuine no-op: no CREATE OR REPLACE, DROP, REVOKE,
-- or GRANT runs against existing custody objects.
DO $matched_v4_create$
BEGIN
  IF pg_catalog.current_setting('addie_matched_v4.create_schema', true) IS DISTINCT FROM 'true' THEN
    RETURN;
  END IF;
  EXECUTE $matched_v4_ddl$

CREATE TABLE IF NOT EXISTS addie_matched_v4_private_runs (
  reservation_id TEXT PRIMARY KEY CHECK (reservation_id ~ '^mv4_[a-f0-9]{32}$'),
  stage TEXT NOT NULL CHECK (stage IN ('screening', 'full')),
  selector_fingerprint CHAR(64) NOT NULL CHECK (selector_fingerprint ~ '^[a-f0-9]{64}$'),
  dispatch_cap INTEGER NOT NULL CHECK (dispatch_cap > 0 AND dispatch_cap <= 1584),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'halted')),
  halt_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Only the externally provisioned operator role can create this admission.
CREATE TABLE IF NOT EXISTS addie_matched_v4_private_admissions (
  admission_id TEXT PRIMARY KEY CHECK (admission_id ~ '^mv4_admission_[a-f0-9]{32}$'),
  merge_sha CHAR(40) NOT NULL CHECK (merge_sha ~ '^[a-f0-9]{40}$'),
  authority_manifest_sha256 CHAR(64) NOT NULL CHECK (authority_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  operator_gate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('operator_authorized', 'claimed')),
  operator_authorized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claimed_at TIMESTAMPTZ,
  UNIQUE (merge_sha, authority_manifest_sha256),
  CHECK ((status = 'operator_authorized' AND claimed_at IS NULL)
    OR (status = 'claimed' AND claimed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS addie_matched_v4_private_attempts (
  reservation_id TEXT NOT NULL REFERENCES addie_matched_v4_private_runs(reservation_id) ON DELETE RESTRICT,
  attempt_id TEXT PRIMARY KEY CHECK (attempt_id ~ '^mv4_attempt_[a-f0-9]{32}$'),
  assignment_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0 AND ordinal <= 1584),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  dispatched_at TIMESTAMPTZ NOT NULL,
  service_tier TEXT NOT NULL CHECK (service_tier = 'standard'),
  pricing_profile_id TEXT NOT NULL,
  pricing_profile_sha256 CHAR(64) NOT NULL CHECK (pricing_profile_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('intent_recorded', 'settled', 'unknown_exposure')),
  response_sha256 CHAR(64),
  cost_microdollars BIGINT CHECK (cost_microdollars >= 0),
  settled_at TIMESTAMPTZ,
  UNIQUE (reservation_id, ordinal),
  CHECK ((status = 'intent_recorded' AND response_sha256 IS NULL AND cost_microdollars IS NULL AND settled_at IS NULL)
    OR (status = 'settled' AND response_sha256 IS NOT NULL AND cost_microdollars IS NOT NULL AND settled_at IS NOT NULL)
    OR (status = 'unknown_exposure' AND response_sha256 IS NULL AND cost_microdollars IS NULL AND settled_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION addie_matched_v4_private_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status TEXT; run_cap INTEGER; already_count INTEGER;
BEGIN
  -- Settlement/reconciliation is deliberately allowed after a halt. It is
  -- recovery of an already ledgered intent, never a new paid dispatch.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'intent_recorded' OR NEW.status NOT IN ('settled', 'unknown_exposure')
      OR NEW.reservation_id <> OLD.reservation_id OR NEW.attempt_id <> OLD.attempt_id
      OR NEW.assignment_id <> OLD.assignment_id OR NEW.ordinal <> OLD.ordinal
      OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.dispatched_at <> OLD.dispatched_at
      OR NEW.service_tier <> OLD.service_tier OR NEW.pricing_profile_id <> OLD.pricing_profile_id
      OR NEW.pricing_profile_sha256 <> OLD.pricing_profile_sha256 THEN
      RAISE EXCEPTION 'matched-v4 attempt is immutable';
    END IF;
    RETURN NEW;
  END IF;
  -- The attempt trigger is also the append-only guard for its relation.
  -- Include DELETE in the trigger shape (rather than relying on an ACL) so
  -- even the evaluator operator cannot erase a reserved pre-network intent.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'matched-v4 attempt custody is append-only';
  END IF;
  SELECT status, dispatch_cap INTO run_status, run_cap FROM public.addie_matched_v4_private_runs WHERE reservation_id = NEW.reservation_id FOR UPDATE;
  IF run_status IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'matched-v4 run is not dispatchable'; END IF;
  SELECT count(*) INTO already_count FROM public.addie_matched_v4_private_attempts WHERE reservation_id = NEW.reservation_id;
  IF already_count >= run_cap THEN RAISE EXCEPTION 'matched-v4 dispatch cap exhausted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS addie_matched_v4_private_attempt_guard ON addie_matched_v4_private_attempts;
CREATE TRIGGER addie_matched_v4_private_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON addie_matched_v4_private_attempts
FOR EACH ROW EXECUTE FUNCTION addie_matched_v4_private_attempt_guard();

-- Evaluator custody is append-only. Attempt settlement is the sole permitted
-- update (enforced above); no run, admission, or attempt history may be
-- deleted, including by a future accidental cascade or maintenance script.
CREATE OR REPLACE FUNCTION addie_matched_v4_private_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'matched-v4 evaluator custody is append-only';
END $$;
DROP TRIGGER IF EXISTS addie_matched_v4_private_runs_append_only_guard ON addie_matched_v4_private_runs;
CREATE TRIGGER addie_matched_v4_private_runs_append_only_guard
  BEFORE DELETE ON addie_matched_v4_private_runs
  FOR EACH ROW EXECUTE FUNCTION addie_matched_v4_private_append_only_guard();
DROP TRIGGER IF EXISTS addie_matched_v4_private_admissions_append_only_guard ON addie_matched_v4_private_admissions;
CREATE TRIGGER addie_matched_v4_private_admissions_append_only_guard
  BEFORE DELETE ON addie_matched_v4_private_admissions
  FOR EACH ROW EXECUTE FUNCTION addie_matched_v4_private_append_only_guard();
DROP TRIGGER IF EXISTS addie_matched_v4_private_attempts_append_only_guard ON addie_matched_v4_private_attempts;
CREATE TRIGGER addie_matched_v4_private_attempts_append_only_guard
  BEFORE DELETE ON addie_matched_v4_private_attempts
  FOR EACH ROW EXECUTE FUNCTION addie_matched_v4_private_append_only_guard();

-- The runtime receives no table DML. These fixed SECURITY DEFINER functions,
-- owned by the external operator role, are its entire evaluator ledger API.
CREATE OR REPLACE FUNCTION addie_matched_v4_private_reserve(TEXT, TEXT, TEXT, INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.addie_matched_v4_private_runs (reservation_id,stage,selector_fingerprint,dispatch_cap,status)
  VALUES ($1,$2,$3,$4,'reserved') ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION addie_matched_v4_private_intent(TEXT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.addie_matched_v4_private_attempts
    (reservation_id,attempt_id,assignment_id,ordinal,request_sha256,dispatched_at,service_tier,pricing_profile_id,pricing_profile_sha256,status)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'intent_recorded');
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION addie_matched_v4_private_settle(TEXT, TEXT, TEXT, TEXT, BIGINT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.addie_matched_v4_private_attempts
    SET status=$3,response_sha256=$4,cost_microdollars=$5,settled_at=clock_timestamp()
    WHERE reservation_id=$1 AND attempt_id=$2 AND status='intent_recorded';
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION addie_matched_v4_private_reconcile(TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE exists_run BOOLEAN;
BEGIN
  UPDATE public.addie_matched_v4_private_attempts
    SET status='unknown_exposure',response_sha256=NULL,cost_microdollars=NULL,settled_at=clock_timestamp()
    WHERE reservation_id=$1 AND status='intent_recorded';
  SELECT EXISTS(SELECT 1 FROM public.addie_matched_v4_private_runs WHERE reservation_id=$1) INTO exists_run;
  RETURN exists_run;
END $$;
CREATE OR REPLACE FUNCTION addie_matched_v4_private_halt(TEXT, TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.addie_matched_v4_private_runs SET status='halted',halt_reason=$2 WHERE reservation_id=$1;
END $$;
CREATE OR REPLACE FUNCTION addie_matched_v4_private_claim_admission(TEXT, TEXT, TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.addie_matched_v4_private_admissions
    SET status='claimed',claimed_at=clock_timestamp()
    WHERE merge_sha=$1 AND authority_manifest_sha256=$2 AND operator_gate_id=$3
      AND status='operator_authorized';
  RETURN FOUND;
END $$;

REVOKE ALL ON TABLE addie_matched_v4_private_runs, addie_matched_v4_private_attempts, addie_matched_v4_private_admissions FROM PUBLIC, addie_matched_v4_runtime;
REVOKE ALL ON FUNCTION addie_matched_v4_private_attempt_guard(), addie_matched_v4_private_append_only_guard(), addie_matched_v4_private_reserve(TEXT,TEXT,TEXT,INTEGER), addie_matched_v4_private_intent(TEXT,TEXT,TEXT,INTEGER,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT), addie_matched_v4_private_settle(TEXT,TEXT,TEXT,TEXT,BIGINT), addie_matched_v4_private_reconcile(TEXT), addie_matched_v4_private_halt(TEXT,TEXT), addie_matched_v4_private_claim_admission(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION addie_matched_v4_private_reserve(TEXT,TEXT,TEXT,INTEGER), addie_matched_v4_private_intent(TEXT,TEXT,TEXT,INTEGER,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT), addie_matched_v4_private_settle(TEXT,TEXT,TEXT,TEXT,BIGINT), addie_matched_v4_private_reconcile(TEXT), addie_matched_v4_private_halt(TEXT,TEXT), addie_matched_v4_private_claim_admission(TEXT,TEXT,TEXT) TO addie_matched_v4_runtime;
$matched_v4_ddl$;
END
$matched_v4_create$;
