import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Registry } from "../../src/registry.js";
import * as configModule from "../../src/config.js";
import * as clientModule from "../../src/db/client.js";
import * as migrateModule from "../../src/db/migrate.js";
import { RegistryDatabase } from "../../src/db/registry-db.js";

// Mock dependencies
vi.mock("../../src/config.js");
vi.mock("../../src/db/client.js");
vi.mock("../../src/db/migrate.js");
vi.mock("../../src/db/registry-db.js");

describe("Registry", () => {
  let registry: Registry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Registry();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("initialization", () => {
    it("should require database configuration", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue(null);

      await expect(registry.initialize()).rejects.toThrow(
        "DATABASE_URL or DATABASE_PRIVATE_URL environment variable is required"
      );
    });

    it("should initialize with database config", async () => {
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue({
        connectionString: "postgresql://localhost/test",
      });
      vi.mocked(clientModule.initializeDatabase).mockReturnValue({} as any);
      vi.mocked(migrateModule.runMigrations).mockResolvedValue();

      await registry.initialize();

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

      await expect(registry.initialize()).rejects.toThrow(
        "Migration failed: schema error"
      );
    });
  });

  describe("agent operations", () => {
    it("should delegate to database registry", async () => {
      const mockAgents = [
        {
          name: "Test Agent",
          type: "creative" as const,
          url: "http://test",
          protocol: "mcp",
          description: "Test",
          mcp_endpoint: "http://test",
          contact: { name: "", email: "", website: "" },
          added_date: "2024-01-01",
        },
      ];

      vi.mocked(RegistryDatabase).mockImplementation(
        () =>
          ({
            listAgents: vi.fn().mockResolvedValue(mockAgents),
            getAgent: vi.fn().mockResolvedValue(mockAgents[0]),
          }) as any
      );

      const testRegistry = new Registry();

      const agents = await testRegistry.listAgents();
      expect(agents).toEqual(mockAgents);

      const agent = await testRegistry.getAgent("test");
      expect(agent).toEqual(mockAgents[0]);
    });

    it("should support agent type filtering", async () => {
      const mockAgents = [
        {
          name: "Creative Agent",
          type: "creative" as const,
          url: "http://creative",
          protocol: "mcp",
          description: "Test",
          mcp_endpoint: "http://creative",
          contact: { name: "", email: "", website: "" },
          added_date: "2024-01-01",
        },
      ];

      const mockListAgents = vi.fn().mockResolvedValue(mockAgents);

      vi.mocked(RegistryDatabase).mockImplementation(
        () =>
          ({
            listAgents: mockListAgents,
          }) as any
      );

      const testRegistry = new Registry();
      await testRegistry.listAgents("creative");

      expect(mockListAgents).toHaveBeenCalledWith("creative");
    });

    it("should get all agents as a map", async () => {
      const mockAgents = [
        {
          name: "Test Agent",
          type: "creative" as const,
          url: "http://test",
          protocol: "mcp",
          description: "Test",
          mcp_endpoint: "http://test",
          contact: { name: "", email: "", website: "" },
          added_date: "2024-01-01",
        },
      ];

      vi.mocked(RegistryDatabase).mockImplementation(
        () =>
          ({
            listAgents: vi.fn().mockResolvedValue(mockAgents),
          }) as any
      );

      const testRegistry = new Registry();
      const agentsMap = await testRegistry.getAllAgents();

      expect(agentsMap instanceof Map).toBe(true);
      expect(agentsMap.size).toBeGreaterThan(0);
    });
  });

  describe("database access", () => {
    it("should expose database registry instance", () => {
      const dbRegistry = registry.getDatabaseRegistry();
      expect(dbRegistry).toBeInstanceOf(RegistryDatabase);
    });
  });
});
