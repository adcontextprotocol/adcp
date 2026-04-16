import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { mountSchemasRoutes } from "../../src/schemas-middleware.js";

/**
 * End-to-end tests for /schemas routing: version alias rewriting, bare-directory
 * redirects, and static file serving. These exercise the real middleware against
 * the built dist/schemas/ tree to catch ordering/wiring bugs that pure-function
 * tests miss.
 */
describe("/schemas HTTP routing", () => {
  const schemasPath = path.join(__dirname, "../../../dist/schemas");
  let app: express.Express;
  let versions: string[] = [];
  let latestStableMajor2: string | undefined;
  let latestPrereleaseMajor3: string | undefined;

  beforeAll(() => {
    versions = fs
      .readdirSync(schemasPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+(-[a-zA-Z]+\.\d+)?$/.test(e.name))
      .map((e) => e.name);

    if (versions.length === 0) {
      throw new Error(`No schema versions found under ${schemasPath}. Run \`npm run build:schemas\` first.`);
    }

    latestStableMajor2 = versions
      .filter((v) => v.startsWith("2.") && !v.includes("-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    latestPrereleaseMajor3 = versions
      .filter((v) => v.startsWith("3."))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

    app = express();
    mountSchemasRoutes(app, schemasPath);
  });

  describe("direct versioned paths", () => {
    it("serves files from a concrete stable version", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get(`/schemas/${latestStableMajor2}/adagents.json`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["cache-control"]).toContain("immutable");
    });

    it("serves files from a concrete prerelease version", async () => {
      if (!latestPrereleaseMajor3) return;
      const res = await request(app).get(`/schemas/${latestPrereleaseMajor3}/adagents.json`);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toContain("immutable");
    });

    it("redirects a bare stable directory to index.json under /schemas", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get(`/schemas/${latestStableMajor2}/`);
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`/schemas/${latestStableMajor2}/index.json`);
    });

    it("redirects a bare prerelease directory to index.json under /schemas", async () => {
      if (!latestPrereleaseMajor3) return;
      const res = await request(app).get(`/schemas/${latestPrereleaseMajor3}/`);
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`/schemas/${latestPrereleaseMajor3}/index.json`);
    });
  });

  describe("version aliases (the bug we just fixed)", () => {
    it("serves /schemas/v2/adagents.json via alias rewrite", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2/adagents.json");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("serves /schemas/v2.5/adagents.json via minor-alias rewrite", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2.5/adagents.json");
      expect(res.status).toBe(200);
    });

    it("serves /schemas/v3/adagents.json via alias rewrite (prerelease-only)", async () => {
      if (!latestPrereleaseMajor3) return;
      const res = await request(app).get("/schemas/v3/adagents.json");
      expect(res.status).toBe(200);
    });

    it("redirects /schemas/v2/ to the resolved stable index.json", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2/");
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`/schemas/${latestStableMajor2}/index.json`);
    });

    it("redirects /schemas/v3/ to the resolved prerelease index.json", async () => {
      if (!latestPrereleaseMajor3) return;
      const res = await request(app).get("/schemas/v3/");
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`/schemas/${latestPrereleaseMajor3}/index.json`);
    });

    it("returns 404 for an alias with no matching major version", async () => {
      const res = await request(app).get("/schemas/v99/adagents.json");
      expect(res.status).toBe(404);
    });
  });

  describe("cache-control policy", () => {
    // Aliases and /latest/ must not be immutably cached — they retarget over time.
    // Only direct versioned paths (client pinned a full semver) get immutable.
    it("does NOT mark alias file responses immutable", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2/adagents.json");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
    });

    it("does NOT mark minor-alias file responses immutable", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2.5/adagents.json");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
    });

    it("does NOT mark /latest/ file responses immutable", async () => {
      const res = await request(app).get("/schemas/latest/adagents.json");
      // /latest/ may or may not exist depending on build; only assert when present.
      if (res.status !== 200) return;
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
    });
  });

  describe("discovery endpoint", () => {
    it("lists versions and aliases at /schemas/", async () => {
      const res = await request(app).get("/schemas/");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.versions)).toBe(true);
      expect(Array.isArray(res.body.aliases)).toBe(true);
      expect(res.body.latest).toMatchObject({ path: "/schemas/latest/" });
    });
  });
});
