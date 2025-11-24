import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HTTPServer } from "../../src/http.js";
import request from "supertest";
import * as configModule from "../../src/config.js";

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

  describe("Health check with database failure", () => {
    let degradedServer: HTTPServer;
    let degradedApp: any;

    beforeAll(async () => {
      // Mock database config to simulate failed connection
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue({
        connectionString: "postgresql://fake:5432/test",
      });

      degradedServer = new HTTPServer();
      degradedApp = (degradedServer as any).app;

      // Initialize - should fail and fallback to file mode
      await (degradedServer as any).registry.initialize();
    });

    afterAll(async () => {
      await degradedServer.stop();
      // Reset mock
      vi.mocked(configModule.getDatabaseConfig).mockReturnValue(null);
    });

    it("should show degraded mode when database fails", async () => {
      const response = await request(degradedApp).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.registry.mode).toBe("file");
      expect(response.body.registry.degraded).toBe(true);
      expect(response.body.registry.error).toBeDefined();
      expect(response.body.registry.error.type).toBeDefined();
    });

    it("should include error details in degraded mode", async () => {
      const response = await request(degradedApp).get("/health");

      expect(response.body.registry.error).toHaveProperty("type");
      expect(response.body.registry.error).toHaveProperty("message");
      expect(["connection", "migration", "unknown"]).toContain(
        response.body.registry.error.type
      );
    });
  });
});
