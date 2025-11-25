import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HTTPServer } from "../../src/http.js";
import request from "supertest";
import * as configModule from "../../src/config.js";
import * as clientModule from "../../src/db/client.js";

// Mock config and database to prevent actual database connections
vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual("../../src/config.js");
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue({
      connectionString: "postgresql://localhost/test",
    }),
  };
});

vi.mock("../../src/db/client.js", () => ({
  initializeDatabase: vi.fn(),
  isDatabaseInitialized: vi.fn().mockReturnValue(true),
  closeDatabase: vi.fn(),
}));

vi.mock("../../src/db/migrate.js", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/db/registry-db.js", () => ({
  RegistryDatabase: vi.fn().mockImplementation(() => ({
    listAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("Health Endpoint Integration", () => {
  let server: HTTPServer;
  let app: any;

  beforeAll(async () => {
    server = new HTTPServer();
    // Access the express app without starting the server
    app = (server as any).app;

    // Initialize registry
    await (server as any).registry.initialize();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("GET /health", () => {
    it("should return health status", async () => {
      const response = await request(app).get("/health");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("registry");
    });

    it("should show database mode", async () => {
      const response = await request(app).get("/health");

      expect(response.body.registry.mode).toBe("database");
      expect(response.body.registry.using_database).toBe(true);
    });
  });

  describe("Database initialization", () => {
    it("should fail when database config is missing", async () => {
      // Mock no database config
      vi.mocked(configModule.getDatabaseConfig).mockReturnValueOnce(null);

      const failingServer = new HTTPServer();

      // Fail-fast behavior: initialization should throw
      await expect((failingServer as any).registry.initialize()).rejects.toThrow(
        "DATABASE_URL or DATABASE_PRIVATE_URL environment variable is required"
      );
    });

    it("should fail when database connection fails", async () => {
      // Mock database initialization error
      vi.mocked(clientModule.initializeDatabase).mockImplementationOnce(() => {
        throw new Error("Connection refused");
      });

      const failingServer = new HTTPServer();

      // Fail-fast behavior: initialization should throw
      await expect((failingServer as any).registry.initialize()).rejects.toThrow(
        "Connection refused"
      );

      // Restore mock
      vi.mocked(clientModule.initializeDatabase).mockImplementation(() => {});
    });
  });
});
