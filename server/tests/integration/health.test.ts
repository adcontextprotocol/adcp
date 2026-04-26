import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HTTPServer } from "../../src/http.js";
import request from "supertest";

// Mock config and database to prevent actual database connections.
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
  // The /health route exercises a dedicated connection via healthCheck().
  // Stubbing it green keeps the test focused on response shape, not on
  // whether vitest workers can reach Postgres.
  healthCheck: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/db/migrate.js", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

describe("Health Endpoint Integration", () => {
  let server: HTTPServer;
  let app: any;

  beforeAll(async () => {
    server = new HTTPServer();
    // Access the express app without starting the listener — /health is
    // registered during HTTPServer construction.
    app = (server as any).app;
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
});
