import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
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
const MATCHED_V4_EXTERNAL_MIGRATION =
  "584_addie_matched_v4_private_authority.sql";
const MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED_ENV =
  "ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED";

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
 * Migration 584 is intentionally applied by a separately administered
 * evaluator operator, not by the general application migrator.  The normal
 * migration ledger still owns its ordering: it records 584 only after this
 * verification proves that the external step completed the sealed schema.
 */
async function validateMatchedV4ExternalSchema(
  client: PoolClient,
): Promise<void> {
  // `pg_get_tabledef` does not exist in supported PostgreSQL versions.  Pin a
  // canonical catalog projection instead: user columns (including order,
  // types, nullability, and defaults), every constraint, and every physical
  // index.  A count-only check would accept a hand-made lookalike table.
  const expectedTableShapeDigests: Readonly<Record<string, string>> = {
    addie_matched_v4_private_admissions:
      "c8758926b069b97aeeffbe1572ae2564ae3890db612de08fbbfabf7885addc73",
    addie_matched_v4_private_attempts:
      "fb3a9baaa408ade459aa338930c244e1fd84877c3ade09a988cd946f735ba4d8",
    addie_matched_v4_private_runs:
      "a5a22e4cc5c1559b10986e447725f412e1c997a8ccdd70d7b90c104a526db60d",
  };
  const tableShapes = await client.query<{
    name: string;
    canonical_shape: string;
  }>(`
    SELECT c.relname AS name,
      jsonb_build_object(
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
      )::text AS canonical_shape
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname = ANY(ARRAY['addie_matched_v4_private_runs',
        'addie_matched_v4_private_admissions', 'addie_matched_v4_private_attempts'])
  `);
  if (
    tableShapes.rows.length !== Object.keys(expectedTableShapeDigests).length ||
    tableShapes.rows.some(
      ({ name, canonical_shape }) =>
        createHash("sha256").update(canonical_shape, "utf8").digest("hex") !==
        expectedTableShapeDigests[name],
    )
  ) {
    throw new Error(
      "Migration 584 evaluator tables do not match the reviewed full catalog shape.",
    );
  }

  // Pin each complete callable definition, not only its PL/pgSQL body. The
  // explicit security-definer and one-item configuration tests below are a
  // second, easy-to-audit attestation of the exact safe search path.
  const expectedRuntimeDefinitions: Readonly<Record<string, string>> = {
    "public.addie_matched_v4_private_reserve(text,text,text,integer)":
      "47cf83cedacdbbabd839b5c5d2780a19898dc94c2021ca15729cf1fc6cd7201e",
    "public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)":
      "d0fc1859fa1237cfd9d1d8a8a6c785dfc99d8607b6b884727f4e880148dca8ad",
    "public.addie_matched_v4_private_settle(text,text,text,text,bigint)":
      "f0374cdaa332b06e3e7200d46d0c3bce261e76a232d6c0e2696746761c4c896e",
    "public.addie_matched_v4_private_reconcile(text)":
      "093b45e79b533fdcc79f152d4a2548a36b1e176736501606c62522899eb3bb28",
    "public.addie_matched_v4_private_halt(text,text)":
      "e7697ba0b1633e7e8f12e531ef6b2fc74813d8f7458bb60b9fade42a711a6151",
    "public.addie_matched_v4_private_claim_admission(text,text,text)":
      "2c4546366b8c677059039c458b8601435a44b64791223ccdbe21b93dbf172b0e",
  };
  const runtimeApi = await client.query<{
    signature: string;
    definition: string;
    security_definer: boolean;
    config: string[] | null;
  }>(
    `
    SELECT n.nspname || '.' || p.proname || '('
      || replace(pg_catalog.pg_get_function_identity_arguments(p.oid), ', ', ',')
      || ')' AS signature,
      pg_catalog.pg_get_functiondef(p.oid) AS definition,
      p.prosecdef AS security_definer, p.proconfig AS config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND n.nspname || '.' || p.proname || '('
        || replace(pg_catalog.pg_get_function_identity_arguments(p.oid), ', ', ',')
        || ')' = ANY($1::text[])
  `,
    [Object.keys(expectedRuntimeDefinitions)],
  );
  if (
    runtimeApi.rows.length !== Object.keys(expectedRuntimeDefinitions).length ||
    runtimeApi.rows.some(
      ({ signature, definition, security_definer, config }) =>
        !security_definer ||
        config?.length !== 1 ||
        config[0] !== "search_path=pg_catalog" ||
        createHash("sha256").update(definition, "utf8").digest("hex") !==
          expectedRuntimeDefinitions[signature],
    )
  ) {
    throw new Error(
      "Migration 584 runtime API body or SECURITY DEFINER search_path is not canonical.",
    );
  }

  const result = await client.query<{
    valid: boolean;
    attempt_guard_definition: string | null;
    append_only_guard_definition: string | null;
  }>(`
    WITH required_tables(name) AS (
      VALUES
        ('addie_matched_v4_private_runs'),
        ('addie_matched_v4_private_admissions'),
        ('addie_matched_v4_private_attempts')
    ), required_api(signature) AS (
      VALUES
        ('public.addie_matched_v4_private_reserve(text,text,text,integer)'),
        ('public.addie_matched_v4_private_intent(text,text,text,integer,text,timestamp with time zone,text,text,text)'),
        ('public.addie_matched_v4_private_settle(text,text,text,text,bigint)'),
        ('public.addie_matched_v4_private_reconcile(text)'),
        ('public.addie_matched_v4_private_halt(text,text)'),
        ('public.addie_matched_v4_private_claim_admission(text,text,text)')
    ), protected_guards(signature) AS (
      VALUES
        ('public.addie_matched_v4_private_attempt_guard()'),
        ('public.addie_matched_v4_private_append_only_guard()')
    ), canonical_triggers(table_name, trigger_name, procedure_signature, trigger_type) AS (
      VALUES
        ('addie_matched_v4_private_attempts',
         'addie_matched_v4_private_attempt_guard',
         'public.addie_matched_v4_private_attempt_guard()', 31),
        ('addie_matched_v4_private_runs',
         'addie_matched_v4_private_runs_append_only_guard',
         'public.addie_matched_v4_private_append_only_guard()', 11),
        ('addie_matched_v4_private_admissions',
         'addie_matched_v4_private_admissions_append_only_guard',
         'public.addie_matched_v4_private_append_only_guard()', 11),
        ('addie_matched_v4_private_attempts',
         'addie_matched_v4_private_attempts_append_only_guard',
         'public.addie_matched_v4_private_append_only_guard()', 11)
    )
    SELECT
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'addie_matched_v4_operator'
          AND NOT rolcanlogin AND NOT rolinherit
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolreplication AND NOT rolbypassrls
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'addie_matched_v4_runtime'
          AND NOT rolcanlogin AND NOT rolinherit
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolreplication AND NOT rolbypassrls
      )
      AND NOT pg_catalog.pg_has_role(
        'addie_matched_v4_runtime', 'addie_matched_v4_operator', 'member'
      )
      -- The ordinary migrator must itself be the deployed application
      -- principal, never a privileged session that SET ROLE to that principal.
      -- session_user is the authenticated identity and must equal the active
      -- application role before this external schema can be recorded.
      AND session_user = current_user
      AND pg_catalog.pg_has_role(
        current_user, 'addie_matched_v4_runtime', 'member'
      )
      AND NOT pg_catalog.pg_has_role(
        current_user, 'addie_matched_v4_operator', 'member'
      )
      AND NOT EXISTS (
        SELECT 1 FROM required_tables
        WHERE to_regclass('public.' || name) IS NULL
          OR (SELECT pg_catalog.pg_get_userbyid(relowner)
              FROM pg_catalog.pg_class
              WHERE oid = to_regclass('public.' || name))
             <> 'addie_matched_v4_operator'
          OR NOT pg_catalog.has_table_privilege(
            'addie_matched_v4_operator', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE'
          )
          OR pg_catalog.has_table_privilege(
            'addie_matched_v4_runtime', 'public.' || name,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
          -- The deployed application login can have direct ACLs that are not
          -- implied by its restricted runtime role. Check it separately.
          OR pg_catalog.has_table_privilege(
            current_user, 'public.' || name,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class c
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
            ) AS acl
            WHERE c.oid = to_regclass('public.' || name)
              AND acl.grantee = 0
              AND acl.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM required_api
        WHERE to_regprocedure(signature) IS NULL
          OR NOT pg_catalog.has_function_privilege(
            'addie_matched_v4_runtime', signature, 'EXECUTE'
          )
          OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = to_regprocedure(signature))
          OR (SELECT pg_catalog.pg_get_userbyid(proowner) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure(signature))
             <> 'addie_matched_v4_operator'
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc p
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) AS acl
            WHERE p.oid = to_regprocedure(signature)
              AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM protected_guards
        WHERE to_regprocedure(signature) IS NULL
          OR (SELECT pg_catalog.pg_get_userbyid(proowner)
              FROM pg_catalog.pg_proc
              WHERE oid = to_regprocedure(signature))
             <> 'addie_matched_v4_operator'
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc p
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) AS acl
            WHERE p.oid = to_regprocedure(signature)
              AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          )
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
        WHERE t.tgname = 'addie_matched_v4_private_attempt_guard'
          AND t.tgrelid = to_regclass('public.addie_matched_v4_private_attempts')
          AND p.oid = to_regprocedure('public.addie_matched_v4_private_attempt_guard()')
          AND pn.nspname = 'public'
          AND pg_catalog.pg_get_userbyid(p.proowner) = 'addie_matched_v4_operator'
          -- PostgreSQL trigger type 31 is ROW | BEFORE | INSERT | UPDATE |
          -- DELETE.  The exact value excludes statement, AFTER/INSTEAD and
          -- TRUNCATE variants; disabled guards cannot attest a dispatch cap
          -- or append-only intent custody.
          AND t.tgtype = 31
          AND t.tgenabled = 'O'
          AND t.tgqual IS NULL
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
        ) AS expected(table_name, trigger_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = expected.trigger_name
            AND t.tgrelid = to_regclass(expected.table_name)
            AND p.oid = to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
            -- ROW | BEFORE | DELETE.  A disabled, conditional, statement,
            -- or differently timed trigger is not append-only custody.
            AND t.tgtype = 11 AND t.tgenabled = 'O' AND t.tgqual IS NULL
            AND NOT t.tgisinternal
        )
      )
      -- Do not merely find the four known guards. Any other user trigger on
      -- a custody relation can rewrite NEW or bypass/augment the reviewed
      -- cap path. The complete non-internal trigger set must be canonical.
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger actual
        WHERE NOT actual.tgisinternal
          AND actual.tgrelid = ANY(ARRAY[
            to_regclass('public.addie_matched_v4_private_runs'),
            to_regclass('public.addie_matched_v4_private_admissions'),
            to_regclass('public.addie_matched_v4_private_attempts')
          ])
          AND NOT EXISTS (
            SELECT 1 FROM canonical_triggers expected
            WHERE actual.tgrelid = to_regclass('public.' || expected.table_name)
              AND actual.tgname = expected.trigger_name
              AND actual.tgfoid = to_regprocedure(expected.procedure_signature)
              AND actual.tgtype = expected.trigger_type
              AND actual.tgenabled = 'O'
              AND actual.tgqual IS NULL
          )
      )
      AS valid
      , pg_catalog.pg_get_functiondef(
          to_regprocedure('public.addie_matched_v4_private_attempt_guard()')
        ) AS attempt_guard_definition
      , pg_catalog.pg_get_functiondef(
          to_regprocedure('public.addie_matched_v4_private_append_only_guard()')
        ) AS append_only_guard_definition
  `);

  const attestation = result.rows[0];
  const expectedAttemptGuardSemantics = [
    "OLD.status <> 'intent_recorded'",
    "NEW.status NOT IN ('settled', 'unknown_exposure')",
    "TG_OP = 'DELETE'",
    "matched-v4 attempt custody is append-only",
    "FOR UPDATE",
    "already_count >= run_cap",
  ];
  const appendOnlySemantic =
    attestation?.append_only_guard_definition?.includes(
      "RAISE EXCEPTION 'matched-v4 evaluator custody is append-only'",
    ) === true;
  const attemptGuardSemantic = expectedAttemptGuardSemantics.every((fragment) =>
    attestation?.attempt_guard_definition?.includes(fragment),
  );
  // The digest makes a same-name/function-signature replacement detectable;
  // semantic fragments make the reviewed safety meaning explicit in review.
  const attestationDigest = (definition: string | null | undefined) =>
    definition && createHash("sha256").update(definition, "utf8").digest("hex");
  const expectedAppendGuardDigest =
    "1f3c9478583665d1a200112c163cc7f6d045bbc734811f7bd475aa746b94120a";
  const expectedAttemptGuardDigest =
    "69a81df2e9937247e56602a5a9d676243b279d12c32a097a788dbc9e2b91c86f";
  if (
    !attestation?.valid ||
    !appendOnlySemantic ||
    !attemptGuardSemantic ||
    attestationDigest(attestation.append_only_guard_definition) !==
      expectedAppendGuardDigest ||
    attestationDigest(attestation.attempt_guard_definition) !==
      expectedAttemptGuardDigest
  ) {
    throw new Error(
      "Migration 584 requires the externally administered matched-v4 evaluator schema. " +
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}

/**
 * Get list of applied migrations with filenames
 */
async function getAppliedMigrations(): Promise<
  Array<{ version: number; filename: string }>
> {
  const pool = getPool();

  const result = await pool.query<{ version: number; filename: string }>(
    "SELECT version, filename FROM schema_migrations ORDER BY version",
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

    if (migration.filename === MATCHED_V4_EXTERNAL_MIGRATION) {
      await validateMatchedV4ExternalSchema(client);
    } else {
      await client.query(migration.sql);
    }

    // Record migration
    await client.query(
      "INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)",
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
    if (migration.filename !== MATCHED_V4_EXTERNAL_MIGRATION) return true;
    if (matchedV4EvaluatorSchemaRequired()) return true;
    // This is not an authorization control. It simply keeps evaluator-only
    // schema custody out of ordinary local/preview/application startup. The
    // protected release path sets the exact opt-in and performs the strict
    // full-catalog attestation in applyMigration before recording 584.
    console.info(
      `Skipping evaluator-only migration: ${MATCHED_V4_EXTERNAL_MIGRATION}`,
    );
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
