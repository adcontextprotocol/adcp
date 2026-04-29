import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import * as clientModule from "../../src/db/client.js";
import fs from "fs/promises";
import path from "path";

// Mock dependencies
vi.mock("../../src/db/client.js");
vi.mock("fs/promises");

describe("Database Migrations", () => {
  let mockPool: any;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

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
        /Migration filename validation failed/
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
        /Duplicate migration version 1/
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
        .mockResolvedValueOnce({ rows: [{ version: 1, filename: "001_test.sql" }] }); // Already applied

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
        "INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)",
        [1, "001_test.sql"]
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
      const insertCalls = mockClient.query.mock.calls.filter(
        (call: any[]) =>
          call[0]?.includes("INSERT INTO schema_migrations")
      );

      expect(insertCalls[0][1]).toEqual([1, "001_first.sql"]);
      expect(insertCalls[1][1]).toEqual([2, "002_second.sql"]);
      expect(insertCalls[2][1]).toEqual([3, "003_third.sql"]);
    });
  });

  describe("migration tracking", () => {
    it("should create migrations table if not exists", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      // Mock the two queries that runMigrations makes
      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({ rows: [] }); // Query applied migrations

      await runMigrations();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations")
      );
    });

    it("should query applied migrations", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      mockPool.query
        .mockResolvedValueOnce({}) // CREATE table
        .mockResolvedValueOnce({ rows: [{ version: 1, filename: "001_test.sql" }, { version: 2, filename: "002_test.sql" }] });

      await runMigrations();

      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT version, filename FROM schema_migrations ORDER BY version"
      );
    });
  });

  describe("collision detection", () => {
    it("should warn on historical filename mismatch (pre-baseline)", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "054_fix_prospect.sql",
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue("CREATE TABLE test;");

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockPool.query
        .mockResolvedValueOnce({}) // CREATE migrations table
        .mockResolvedValueOnce({
          rows: [{ version: 54, filename: "054_addie_thread_context.sql" }],
        });

      await runMigrations();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Historical migration filename mismatches")
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
        /Migration 400 on disk is "400_storyboard_status.sql" but was applied as "400_marketing_opt_in.sql"/
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
      const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises");
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

      const dupes = Object.entries(versionsByNumber).filter(([, fs]) => fs.length > 1);
      expect(
        dupes.map(([v, fs]) => `version ${v}: ${fs.join(", ")}`),
        "Duplicate migration version numbers found — rebase your branch and renumber the colliding migration",
      ).toEqual([]);
      expect(malformed, "Migration filenames must match NNN_description.sql").toEqual([]);

      vi.doMock("fs/promises");
    });
  });

  describe("error handling", () => {
    it("should handle missing migrations directory", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(
        new Error("ENOENT: no such file or directory")
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
      const lockIdx = calls.findIndex((c: any[]) => c[0] === "SELECT pg_advisory_lock($1)");
      const unlockIdx = calls.findIndex((c: any[]) => c[0] === "SELECT pg_advisory_unlock($1)");
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
      vi.mocked(fs.readdir).mockRejectedValue(new Error("real migration error"));
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
  });
});
