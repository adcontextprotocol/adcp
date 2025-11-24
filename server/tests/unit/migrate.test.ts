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
      query: vi.fn(),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(mockClient),
    };

    vi.mocked(clientModule.getPool).mockReturnValue(mockPool);
  });

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
        .mockResolvedValueOnce({ rows: [{ version: 1 }] }); // Already applied

      await runMigrations();

      // Should not apply migration
      expect(mockClient.connect).not.toHaveBeenCalled();
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

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error("SQL error")); // Migration fails

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

      await runMigrations();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations")
      );
    });

    it("should query applied migrations", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      mockPool.query
        .mockResolvedValueOnce({}) // CREATE table
        .mockResolvedValueOnce({ rows: [{ version: 1 }, { version: 2 }] });

      await runMigrations();

      expect(mockPool.query).toHaveBeenCalledWith(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
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
});
