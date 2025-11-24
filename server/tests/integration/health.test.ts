import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HTTPServer } from "../../src/http.js";
import request from "supertest";
import * as configModule from "../../src/config.js";
import fs from "fs/promises";
import path from "path";

// Mock config to prevent actual database connections
vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual("../../src/config.js");
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue(null),
    getRegistryPath: vi.fn().mockReturnValue("/tmp/test-registry"),
  };
});

describe("Health Endpoint Integration", () => {
  let server: HTTPServer;
  let app: any;

  beforeAll(async () => {
    // Create test registry directories
    const testRegistryPath = "/tmp/test-registry";
    await fs.mkdir(testRegistryPath, { recursive: true });
    await fs.mkdir(path.join(testRegistryPath, "creative"), { recursive: true });
    await fs.mkdir(path.join(testRegistryPath, "signals"), { recursive: true });
    await fs.mkdir(path.join(testRegistryPath, "sales"), { recursive: true });

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
    it("should return health status with registry mode", async () => {
      const response = await request(app).get("/health");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("registry");
      expect(response.body.registry).toHaveProperty("mode");
      expect(response.body.registry).toHaveProperty("using_database");
    });

    it("should show file mode when database not configured", async () => {
      const response = await request(app).get("/health");

      expect(response.body.registry.mode).toBe("file");
      expect(response.body.registry.using_database).toBe(false);
    });

    it("should not show degraded flag when in normal file mode", async () => {
      const response = await request(app).get("/health");

      expect(response.body.registry).not.toHaveProperty("degraded");
      expect(response.body.registry).not.toHaveProperty("error");
    });
  });

  describe("Database failure behavior (fail-fast)", () => {
    it("should fail initialization when database is unavailable", async () => {
      // Mock database config to simulate failed connection
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue({
        connectionString: "postgresql://fake:5432/test",
      });

      const failingServer = new HTTPServer();

      // Fail-fast behavior: initialization should throw
      await expect((failingServer as any).registry.initialize()).rejects.toThrow();

      // Reset mock
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue(null);
    });
  });
});
