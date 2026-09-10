import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import * as clientModule from "../../src/db/client.js";
import fs from "fs/promises";
import path from "path";
import { readFileSync } from "node:fs";

// Mock dependencies
vi.mock("../../src/db/client.js");
vi.mock("fs/promises");

describe("Database Migrations", () => {
  let mockPool: any;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED;

    mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(mockClient),
    };

    vi.mocked(clientModule.getPool).mockReturnValue(mockPool);
  });

  /** runMigrations always grabs one client for pg_advisory_lock. Tests that
   * want to verify "no migration was applied" should check for BEGIN, not
   * raw connect() count. */
  const wasMigrationApplied = () =>
    mockClient.query.mock.calls.some((call: any[]) => call[0] === "BEGIN");

  describe("migration filename validation", () => {
    it("should reject invalid migration filenames", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "invalid-migration.sql",
        "001_valid.sql",
      ] as any);

      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(runMigrations()).rejects.toThrow(
        /Migration filename validation failed/,
      );
    });

    it("should reject duplicate version numbers", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "001_first.sql",
        "001_second.sql",
      ] as any);

      vi.mocked(fs.readFile).mockResolvedValue("CREATE TABLE test;");
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(runMigrations()).rejects.toThrow(
        /Duplicate migration version 1/,
      );
    });

    it("should accept valid migration filenames", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "001_initial.sql",
        "002_add_indexes.sql",
        "010_another_migration.sql",
      ] as any);

      vi.mocked(fs.readFile).mockResolvedValue("CREATE TABLE test;");
      mockPool.query.mockResolvedValue({ rows: [] });
      mockClient.query.mockResolvedValue({});

      await runMigrations();

      // Should have processed all migrations
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
    });
  });

  describe("migration execution", () => {
    beforeEach(() => {
      vi.mocked(fs.readdir).mockResolvedValue(["001_test.sql"] as any);
      vi.mocked(fs.readFile).mockResolvedValue("CREATE TABLE test;");
    });

    it("should skip already applied migrations", async () => {
      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({
          rows: [{ version: 1, filename: "001_test.sql" }],
        }); // Already applied

      await runMigrations();

      expect(wasMigrationApplied()).toBe(false);
    });

    it("should apply pending migrations in transaction", async () => {
      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({ rows: [] }); // No applied migrations

      mockClient.query.mockResolvedValue({});

      await runMigrations();

      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("CREATE TABLE test;");
      expect(mockClient.query).toHaveBeenCalledWith(
        "INSERT INTO public.schema_migrations (version, filename) VALUES ($1, $2)",
        [1, "001_test.sql"],
      );
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should rollback on migration failure", async () => {
      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({ rows: [] }); // No applied migrations

      // First call to mockClient.query is the advisory lock; default mock
      // (resolves to {}) handles it. Override the migration SQL itself to
      // reject so applyMigration triggers ROLLBACK.
      mockClient.query.mockImplementation((text: string) => {
        if (text === "CREATE TABLE test;") {
          return Promise.reject(new Error("SQL error"));
        }
        return Promise.resolve({});
      });

      await expect(runMigrations()).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should apply migrations in version order", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "003_third.sql",
        "001_first.sql",
        "002_second.sql",
      ] as any);

      vi.mocked(fs.readFile).mockResolvedValue("CREATE TABLE test;");

      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({ rows: [] }); // No applied migrations

      mockClient.query.mockResolvedValue({});

      await runMigrations();

      // Check order of migration records
      const insertCalls = mockClient.query.mock.calls.filter((call: any[]) =>
        call[0]?.includes("INSERT INTO public.schema_migrations"),
      );

      expect(insertCalls[0][1]).toEqual([1, "001_first.sql"]);
      expect(insertCalls[1][1]).toEqual([2, "002_second.sql"]);
      expect(insertCalls[2][1]).toEqual([3, "003_third.sql"]);
    });
  });

  describe("evaluator-only migration isolation", () => {
    const externalMigration = "584_addie_matched_v4_private_authority.sql";
    const transformedExternalMigration =
      "585_addie_matched_v4_record_estimated_cost.sql";

    beforeEach(() => {
      vi.mocked(fs.readdir).mockResolvedValue([externalMigration] as any);
      vi.mocked(fs.readFile).mockResolvedValue("-- externally provisioned");
      mockPool.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] });
    });

    it("lets an evaluator-disabled fresh application boot without private schema", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      await runMigrations();

      expect(wasMigrationApplied()).toBe(false);
      expect(infoSpy).toHaveBeenCalledWith(
        `Skipping evaluator-only migration: ${externalMigration}`,
      );
      infoSpy.mockRestore();
    });

    it("does not re-attest post-record evaluator drift during ordinary app boot", async () => {
      mockPool.query.mockReset();
      mockPool.query.mockResolvedValueOnce({}).mockResolvedValueOnce({
        rows: [{ version: 584, filename: externalMigration }],
      });

      await runMigrations();

      expect(wasMigrationApplied()).toBe(false);
      expect(mockClient.query).not.toHaveBeenCalledWith(
        expect.stringContaining("canonical_shape"),
      );
    });

    it("fails closed on absent evaluator schema only for the protected opt-in", async () => {
      process.env.ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED = "true";
      mockClient.query.mockResolvedValue({ rows: [] });

      await expect(runMigrations()).rejects.toThrow(
        "Migrations 584 and 585 require the externally administered transformed matched-v4 evaluator schema.",
      );
      expect(wasMigrationApplied()).toBe(true);
    });

    it("requires 585's transformed schema before recording even migration 584", async () => {
      process.env.ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED = "true";
      vi.mocked(fs.readdir).mockResolvedValue([
        externalMigration,
        transformedExternalMigration,
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue("-- externally provisioned");
      mockClient.query.mockResolvedValue({ rows: [{ valid: false }] });

      await expect(runMigrations()).rejects.toThrow(
        "Migrations 584 and 585 require the externally administered transformed matched-v4 evaluator schema.",
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("record_response_usage"),
      );
    });

    it("ships a zero-evidence, admission-after-585 protected transition", () => {
      const here = path.dirname(new URL(import.meta.url).pathname);
      const migration = readFileSync(
        path.resolve(
          here,
          "../../src/db/migrations/585_addie_matched_v4_record_estimated_cost.sql",
        ),
        "utf8",
      );
      const workflow = readFileSync(
        path.resolve(
          here,
          "../../../.github/workflows/provision-matched-v4-evaluator.yml",
        ),
        "utf8",
      );
      const migrationSmoke = readFileSync(
        path.resolve(
          here,
          "../../../.github/workflows/migration-smoke-test.yml",
        ),
        "utf8",
      );
      const runbook = readFileSync(
        path.resolve(
          here,
          "../../../docs/runbooks/addie-matched-v4-private-authority.md",
        ),
        "utf8",
      );
      expect(migration).toContain(
        "attempts_count <> 0 OR admissions_count <> 0 OR runs_count <> 0",
      );
      expect(migration).toContain("estimated_cost_microdollars");
      expect(migration).toContain("terminal_recorded_at");
      expect(migration).toContain("response_usage_recorded");
      expect(migration).toContain(
        "DROP FUNCTION public.addie_matched_v4_private_settle",
      );
      expect(migration).toContain("existing_attempt_guard_md5");
      expect(migration).toContain("existing_append_guard_md5");
      expect(migration).toContain("Full function definitions are pinned");
      expect(migration).toContain("8dc693482e69a981110ffa1c547b1f69");
      expect(migration).toContain("existing_relations <> 8");
      expect(migration).toContain(
        "c.relname LIKE 'addie_matched_v4_private_%'",
      );
      expect(migration).toContain("existing_constraint_trigger_shape_valid");
      expect(migration).toContain("t.tgisinternal AND t.tgconstraint <> 0");
      expect(migration).toContain("incoming foreign key on an unrelated table");
      expect(migration).toContain("RI_FKey_restrict_del");
      expect(migration).toContain("NOT rolbypassrls");
      expect(migration).toContain("pg_advisory_xact_lock(584585)");
      expect(migration).toContain("IN ACCESS SHARE MODE");
      expect(migration).toContain("IN ACCESS EXCLUSIVE MODE");
      expect(migration).toContain("requires READ COMMITTED isolation");
      expect(migration).toContain("relpersistence");
      expect(migration).toContain("relrowsecurity");
      expect(migration).toContain("pg_catalog.pg_policy");
      expect(migration).toContain("relhasrules");
      expect(migration).toContain("pg_catalog.pg_rewrite");
      expect(migration).toContain("relispartition");
      expect(migration).toContain("pg_catalog.pg_inherits");
      expect(migration).toContain("pg_catalog.pg_depend");
      expect(migration).toContain("relowner=(SELECT oid");
      expect(migration).toContain("proowner=(SELECT oid");
      expect(migration).toContain("tgattr=''::int2vector");
      expect(migration).toContain("a.attacl IS NOT NULL");
      expect(migration).toContain("has_column_privilege");
      expect(migration).toContain("attcollation");
      expect(migration).toContain("attidentity");
      expect(migration).toContain("attgenerated");
      expect(migration).toContain("a.attisdropped");
      expect(migration).toContain("has_schema_privilege");
      expect(migration).toContain("acl.privilege_type='CREATE'");
      expect(migration).toContain("pg_toast");
      expect(migration).toContain("reltoastrelid");
      expect(migration).toContain("private_%') = 8");
      expect(migration).not.toContain("attestation_lock");
      expect(migration).toContain(
        "to_regprocedure(expected.signature) IS NULL",
      );
      expect(migration).toContain("Canonical enabled, unconditional trigger");
      const v584 = workflow.indexOf(
        "-f server/src/db/migrations/584_addie_matched_v4_private_authority.sql",
      );
      const v585 = workflow.indexOf(
        "-f server/src/db/migrations/585_addie_matched_v4_record_estimated_cost.sql",
        v584,
      );
      const admission = workflow.indexOf(
        "INSERT INTO public.addie_matched_v4_private_admissions",
      );
      expect(v584).toBeGreaterThanOrEqual(0);
      expect(v585).toBeGreaterThan(v584);
      expect(admission).toBeGreaterThan(v585);
      expect(workflow).toContain("First application is atomic");
      expect(workflow).toContain(
        "Re-run 585's read-only exact transformed-schema attestation",
      );
      expect(workflow).toContain('if [ "$transformed" = t ]; then');
      expect(migrationSmoke).toContain("runtime EXECUTE on attempt guard");
      expect(migrationSmoke).toContain("unexpected prefixed view");
      expect(migrationSmoke).toContain(
        "disabled internal foreign-key enforcement trigger",
      );
      expect(migrationSmoke).toContain("accepted an elevated runtime role");
      expect(migrationSmoke).toContain("hidden operator SET ROLE bridge");
      expect(migrationSmoke).toContain("nested operator SET ROLE bridge");
      expect(migrationSmoke).toContain("elevated operator-bridge member role");
      expect(migrationSmoke).toContain("runtime replica-mode trigger bypass");
      expect(migrationSmoke).toContain("database replica-mode trigger bypass");
      expect(migrationSmoke).toContain(
        "runtime SET session_replication_role privilege",
      );
      expect(migrationSmoke).toContain("Restoration itself must satisfy 585");
      expect(migrationSmoke).toContain("mv4_attested_sleep");
      expect(migrationSmoke).toContain("incoming foreign-key internal trigger");
      expect(migrationSmoke).toContain("runtime_direct_access");
      expect(migrationSmoke).toContain("runtime column SELECT privilege");
      expect(migrationSmoke).toContain("search-path shadow migration ledger");
      expect(migrationSmoke).toContain("mv4_legacy_evidence_writer");
      expect(migrationSmoke).toContain("AccessExclusiveLock");
      expect(migrationSmoke).toContain("temporary setup CREATE");
      expect(migrationSmoke).toContain("mv4_legacy_repeatable_read_race");
      expect(migrationSmoke).toContain("column-filtered cap guard");
      expect(migrationSmoke).toContain("unlogged evaluator attempts relation");
      expect(migrationSmoke).toContain("RLS evaluator attempts relation");
      expect(migrationSmoke).toContain(
        "rewrite-rule evaluator attempts relation",
      );
      expect(migrationSmoke).toContain("inherited evaluator runs relation");
      expect(migrationSmoke).toContain("evaluator column collation drift");
      expect(migrationSmoke).toContain("evaluator column identity drift");
      expect(migrationSmoke).toContain("dropped evaluator attribute slot");
      expect(migrationSmoke).toContain("runtime TOAST table access");
      expect(migrationSmoke).toContain(
        "direct app-principal TOAST column access",
      );
      expect(migrationSmoke).toContain("externally owned evaluator TOAST view");
      expect(migrationSmoke).toContain("runtime schema CREATE privilege");
      expect(migrationSmoke).toContain(
        "missing operator schema CREATE privilege",
      );
      expect(migrationSmoke).toContain(
        "direct app-principal schema CREATE privilege",
      );
      expect(migrationSmoke).toContain("elevated direct app-principal role");
      expect(migrationSmoke).toContain(
        "static operator parent-role escalation",
      );
      expect(migration).toContain(
        "edge.member IN ('addie_matched_v4_operator'",
      );
      expect(migrationSmoke).toContain("PUBLIC schema CREATE privilege");
      expect(migrationSmoke).toContain(
        "missing runtime schema USAGE privilege",
      );
      expect(migrationSmoke).toContain(
        "unprefixed operator-owned evaluator view",
      );
      expect(migrationSmoke).toContain(
        "externally owned evaluator-dependent view",
      );
      expect(migrationSmoke).toContain(
        "unprefixed operator-owned SECURITY DEFINER helper",
      );
      expect(workflow).toContain("pg_advisory_xact_lock(584585)");
      const admissionCapture = workflow.indexOf("admission_valid=$(psql");
      const captureLock = workflow.indexOf(
        "DO $$ BEGIN PERFORM pg_advisory_xact_lock(584585); END $$",
        admissionCapture,
      );
      expect(captureLock).toBeGreaterThan(admissionCapture);
      expect(captureLock).toBeLessThan(admission);
      const initialIsolation = workflow.indexOf(
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
      );
      expect(initialIsolation).toBeGreaterThan(-1);
      expect(initialIsolation).toBeLessThan(v584);
      expect(runbook).toContain("cooperative serialization boundary");
      expect(runbook).toContain("trusted control-plane TCB");
    });

    it("holds the evaluator serialization locks through the external migration record", async () => {
      process.env.ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED = "true";
      vi.mocked(fs.readdir).mockResolvedValue([externalMigration] as any);
      vi.mocked(fs.readFile).mockResolvedValue("-- externally provisioned");
      mockClient.query.mockImplementation((sql: string) => {
        if (sql.includes("WITH required_tables")) {
          return Promise.resolve({ rows: [{ valid: true }] });
        }
        return Promise.resolve({});
      });

      await runMigrations();

      const calls = mockClient.query.mock.calls.map((call: any[]) => call[0]);
      const transactionStart = calls.indexOf("BEGIN");
      const evaluatorLock = calls.indexOf("SELECT pg_advisory_xact_lock($1)");
      const attestation = calls.findIndex((sql: string) =>
        sql.includes("WITH required_tables"),
      );
      const record = calls.indexOf(
        "INSERT INTO public.schema_migrations (version, filename) VALUES ($1, $2)",
      );
      const commit = calls.indexOf("COMMIT");

      expect(transactionStart).toBeLessThan(evaluatorLock);
      expect(evaluatorLock).toBeLessThan(attestation);
      expect(attestation).toBeLessThan(record);
      expect(record).toBeLessThan(commit);
      expect(mockClient.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_xact_lock($1)",
        [584585],
      );
    });
  });

  describe("migration tracking", () => {
    it("uses a pre-provisioned migration ledger without schema CREATE", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      mockPool.query
        .mockRejectedValueOnce({ code: "42501" })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [] });

      await runMigrations();

      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
      );
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS public.schema_migrations",
        ),
      );
    });

    it("should create migrations table if not exists", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      // Mock the two queries that runMigrations makes
      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({ rows: [] }); // Query applied migrations

      await runMigrations();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS public.schema_migrations",
        ),
      );
    });

    it("should query applied migrations", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      mockPool.query
        .mockResolvedValueOnce({}) // CREATE table
        .mockResolvedValueOnce({
          rows: [
            { version: 1, filename: "001_test.sql" },
            { version: 2, filename: "002_test.sql" },
          ],
        });

      await runMigrations();

      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT version, filename FROM public.schema_migrations ORDER BY version",
      );
    });
  });

  describe("collision detection", () => {
    it("should warn on historical filename mismatch (pre-baseline)", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["054_fix_prospect.sql"] as any);
      vi.mocked(fs.readFile).mockResolvedValue("CREATE TABLE test;");

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({
          rows: [{ version: 54, filename: "054_addie_thread_context.sql" }],
        });

      await runMigrations();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Historical migration filename mismatches"),
      );
      // Should NOT re-apply the mismatched migration
      expect(wasMigrationApplied()).toBe(false);

      consoleSpy.mockRestore();
    });

    it("should throw on filename mismatch above baseline", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "400_storyboard_status.sql",
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue("CREATE TABLE test;");

      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({
          rows: [{ version: 400, filename: "400_marketing_opt_in.sql" }],
        });

      await expect(runMigrations()).rejects.toThrow(
        /Migration 400 on disk is "400_storyboard_status.sql" but was applied as "400_marketing_opt_in.sql"/,
      );

      // Should NOT re-apply the mismatched migration
      expect(wasMigrationApplied()).toBe(false);
    });
  });

  describe("migrations directory invariant", () => {
    // Real filesystem (un-mocks the fs/promises mock that the rest of the
    // suite uses). This is a fast structural assertion — the migrations
    // directory itself, as committed, must have no duplicate version
    // numbers and no malformed filenames. Catches the case where two
    // branches both passed the pull_request workflow on different snapshots
    // of main and got merged with colliding numbers.
    it("has no duplicate migration version numbers on disk", async () => {
      vi.doUnmock("fs/promises");
      const realFs =
        await vi.importActual<typeof import("fs/promises")>("fs/promises");
      const { fileURLToPath } = await import("node:url");
      const here = path.dirname(fileURLToPath(import.meta.url));
      const migrationsDir = path.resolve(here, "../../src/db/migrations");

      const files = await realFs.readdir(migrationsDir);
      const sqlFiles = files.filter((f) => f.endsWith(".sql"));

      const versionsByNumber: Record<number, string[]> = {};
      const malformed: string[] = [];
      for (const file of sqlFiles) {
        const m = file.match(/^(\d+)_(.+)\.sql$/);
        if (!m) {
          malformed.push(file);
          continue;
        }
        const version = parseInt(m[1], 10);
        if (isNaN(version)) {
          malformed.push(file);
          continue;
        }
        (versionsByNumber[version] ||= []).push(file);
      }

      const dupes = Object.entries(versionsByNumber).filter(
        ([, fs]) => fs.length > 1,
      );
      expect(
        dupes.map(([v, fs]) => `version ${v}: ${fs.join(", ")}`),
        "Duplicate migration version numbers found — rebase your branch and renumber the colliding migration",
      ).toEqual([]);
      expect(
        malformed,
        "Migration filenames must match NNN_description.sql",
      ).toEqual([]);

      vi.doMock("fs/promises");
    });
  });

  describe("error handling", () => {
    it("should handle missing migrations directory", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(
        new Error("ENOENT: no such file or directory"),
      );

      await expect(runMigrations()).rejects.toThrow();
    });

    it("should handle migration file read errors", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["001_test.sql"] as any);
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Permission denied"));

      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(runMigrations()).rejects.toThrow();
    });
  });

  describe("advisory lock", () => {
    // Hard-code rather than import: this *is* the wire-format check.
    // If the constant in migrate.ts changes, that's a behavior change
    // that requires a deliberate test update — we don't want test/source
    // to drift in lockstep through a shared import.
    const EXPECTED_LOCK_KEY = 0x6d696772;

    it("acquires and releases pg_advisory_lock around the run", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      mockPool.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] });

      await runMigrations();

      expect(mockClient.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_lock($1)",
        [EXPECTED_LOCK_KEY],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_unlock($1)",
        [EXPECTED_LOCK_KEY],
      );
      expect(mockClient.release).toHaveBeenCalled();

      // Lock must precede the migrations table create; unlock must follow it.
      const calls = mockClient.query.mock.calls;
      const lockIdx = calls.findIndex(
        (c: any[]) => c[0] === "SELECT pg_advisory_lock($1)",
      );
      const unlockIdx = calls.findIndex(
        (c: any[]) => c[0] === "SELECT pg_advisory_unlock($1)",
      );
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(unlockIdx).toBeGreaterThan(lockIdx);
    });

    it("releases the lock even when migrations throw", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("boom"));

      await expect(runMigrations()).rejects.toThrow("boom");

      expect(mockClient.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_unlock($1)",
        [EXPECTED_LOCK_KEY],
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("does not shadow migration errors when unlock itself fails", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(
        new Error("real migration error"),
      );
      mockClient.query.mockImplementation((text: string) => {
        if (text === "SELECT pg_advisory_unlock($1)") {
          return Promise.reject(new Error("unlock failed"));
        }
        return Promise.resolve({});
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(runMigrations()).rejects.toThrow("real migration error");

      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to release migration advisory lock:",
        expect.any(Error),
      );
      expect(mockClient.release).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("bounds lock acquisition with statement_timeout, then clears it", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      mockPool.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] });

      await runMigrations();

      const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
      const setTimeoutIdx = calls.findIndex((q: string) =>
        /SET statement_timeout = '5min'/.test(q),
      );
      const lockIdx = calls.findIndex(
        (q: string) => q === "SELECT pg_advisory_lock($1)",
      );
      const clearTimeoutIdx = calls.findIndex((q: string) =>
        /SET statement_timeout = 0/.test(q),
      );

      expect(setTimeoutIdx).toBeGreaterThanOrEqual(0);
      expect(lockIdx).toBeGreaterThan(setTimeoutIdx);
      expect(clearTimeoutIdx).toBeGreaterThan(lockIdx);
    });

    it("surfaces a clear error when lock acquisition times out (pg 57014)", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      mockClient.query.mockImplementation((text: string) => {
        if (text === "SELECT pg_advisory_lock($1)") {
          const err = new Error(
            "canceling statement due to statement timeout",
          ) as Error & { code: string };
          err.code = "57014";
          return Promise.reject(err);
        }
        return Promise.resolve({});
      });

      await expect(runMigrations()).rejects.toThrow(
        /A prior runMigrations\(\) session is likely wedged/,
      );

      // Even on the timeout path, the connection must be released.
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
