import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HTTPServer } from "../../src/http.js";
import { healthCheck } from "../../src/db/client.js";
import { logger } from "../../src/logger.js";
import { notifySystemError } from "../../src/addie/error-notifier.js";
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
  getPool: vi.fn().mockReturnValue({ query: vi.fn() }),
  isDatabaseInitialized: vi.fn().mockReturnValue(true),
  closeDatabase: vi.fn(),
  // The /health route exercises the dedicated reusable connection via healthCheck().
  // Stubbing it green keeps the test focused on response shape, not on
  // whether vitest workers can reach Postgres.
  healthCheck: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/db/migrate.js", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/addie/error-notifier.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/addie/error-notifier.js")>(
    "../../src/addie/error-notifier.js",
  );
  return { ...actual, notifySystemError: vi.fn() };
});

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

    it("alerts once for a sustained database outage and reports recovery", async () => {
      const healthCheckMock = vi.mocked(healthCheck);
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
      const notifyMock = vi.mocked(notifySystemError);
      notifyMock.mockClear();
      healthCheckMock.mockRejectedValue(new Error("timeout expired"));

      for (let i = 0; i < 5; i += 1) {
        const response = await request(app).get("/health");
        expect(response.status).toBe(503);
      }

      expect(errorSpy).not.toHaveBeenCalled();
      expect(notifyMock).toHaveBeenCalledOnce();
      expect(notifyMock).toHaveBeenCalledWith({
        source: "health-check",
        errorMessage: "Database health check failed (3 consecutive): timeout expired",
      });

      healthCheckMock.mockResolvedValue(undefined);
      await request(app).get("/health").expect(200);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ priorFailures: 5 }),
        "Database health check recovered",
      );
      vi.restoreAllMocks();
    });
  });
});
