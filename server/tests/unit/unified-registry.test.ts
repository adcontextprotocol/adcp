import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { UnifiedRegistry } from "../../src/unified-registry.js";
import * as configModule from "../../src/config.js";
import * as clientModule from "../../src/db/client.js";
import * as migrateModule from "../../src/db/migrate.js";
import { Registry } from "../../src/registry.js";

// Mock dependencies
vi.mock("../../src/config.js");
vi.mock("../../src/db/client.js");
vi.mock("../../src/db/migrate.js");
vi.mock("../../src/registry.js");
vi.mock("../../src/db/registry-db.js");

describe("UnifiedRegistry", () => {
  let registry: UnifiedRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new UnifiedRegistry();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("initialization", () => {
    it("should use file-based registry when no database config", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue(null);

      // Need to create a new registry instance after mocking to capture the mocked Registry constructor
      const mockLoad = vi.fn().mockResolvedValue(undefined);
      vi.mocked(Registry).mockImplementation(() => ({
        load: mockLoad,
        listAgents: vi.fn(),
        getAgent: vi.fn(),
        getAllAgents: vi.fn(),
      }) as any);

      // Create new instance after mock is set up
      const testRegistry = new UnifiedRegistry();
      await testRegistry.initialize();

      expect(testRegistry.getMode()).toBe("file");
      expect(testRegistry.isUsingDatabase()).toBe(false);
      expect(mockLoad).toHaveBeenCalled();
    });

    it("should use database when config is available", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue({
        connectionString: "postgresql://localhost/test",
      });
      vi.mocked(clientModule.initializeDatabase).mockReturnValue({} as any);
      vi.mocked(migrateModule.runMigrations).mockResolvedValue();

      await registry.initialize();

      expect(registry.getMode()).toBe("database");
      expect(registry.isUsingDatabase()).toBe(true);
      expect(clientModule.initializeDatabase).toHaveBeenCalled();
      expect(migrateModule.runMigrations).toHaveBeenCalled();
    });

    it("should fail fast when database initialization fails", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue({
        connectionString: "postgresql://localhost/test",
      });
      vi.mocked(clientModule.initializeDatabase).mockImplementation(() => {
        throw new Error("Connection refused");
      });

      // Fail-fast behavior: initialization should throw
      await expect(registry.initialize()).rejects.toThrow("Connection refused");
    });

    it("should fail fast when migrations fail", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue({
        connectionString: "postgresql://localhost/test",
      });
      vi.mocked(clientModule.initializeDatabase).mockReturnValue({} as any);
      vi.mocked(migrateModule.runMigrations).mockRejectedValue(
        new Error("Migration failed: schema error")
      );

      // Fail-fast behavior: migration errors should throw
      await expect(registry.initialize()).rejects.toThrow("Migration failed: schema error");
    });
  });

  describe("agent operations", () => {
    it("should delegate to file registry in file mode", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue(null);

      const mockAgents = [
        { name: "Test Agent", type: "creative" as const, url: "http://test" },
      ];
      const mockListAgents = vi.fn().mockReturnValue(mockAgents);
      const mockGetAgent = vi.fn().mockReturnValue(mockAgents[0]);

      vi.mocked(Registry).mockImplementation(() => ({
        load: vi.fn().mockResolvedValue(undefined),
        listAgents: mockListAgents,
        getAgent: mockGetAgent,
        getAllAgents: vi.fn().mockReturnValue(new Map()),
      }) as any);

      // Create new instance after mock is set up
      const testRegistry = new UnifiedRegistry();
      await testRegistry.initialize();

      const agents = await testRegistry.listAgents();
      expect(agents).toEqual(mockAgents);
      expect(mockListAgents).toHaveBeenCalled();

      const agent = await testRegistry.getAgent("test");
      expect(agent).toEqual(mockAgents[0]);
      expect(mockGetAgent).toHaveBeenCalledWith("test");
    });
  });

  describe("diagnostics", () => {
    it("should expose mode information in file mode", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue(null);

      const mockLoad = vi.fn().mockResolvedValue(undefined);
      vi.mocked(Registry).mockImplementation(() => ({
        load: mockLoad,
        listAgents: vi.fn(),
        getAgent: vi.fn(),
        getAllAgents: vi.fn(),
      }) as any);

      const testRegistry = new UnifiedRegistry();
      await testRegistry.initialize();

      expect(testRegistry.getMode()).toBe("file");
      expect(testRegistry.isUsingDatabase()).toBe(false);
    });

    it("should expose mode information in database mode", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue({
        connectionString: "postgresql://localhost/test",
      });
      vi.mocked(clientModule.initializeDatabase).mockReturnValue({} as any);
      vi.mocked(migrateModule.runMigrations).mockResolvedValue();

      const testRegistry = new UnifiedRegistry();
      await testRegistry.initialize();

      expect(testRegistry.getMode()).toBe("database");
      expect(testRegistry.isUsingDatabase()).toBe(true);
    });
  });
});
