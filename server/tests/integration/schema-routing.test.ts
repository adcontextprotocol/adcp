import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import semver from "semver";
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
  let latestStableMajor3: string | undefined;
  let latestPrereleaseMajor3: string | undefined;

  beforeAll(() => {
    versions = fs
      .readdirSync(schemasPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+(-[a-zA-Z]+\.\d+)?$/.test(e.name))
      .map((e) => e.name);

    if (versions.length === 0) {
      throw new Error(`No schema versions found under ${schemasPath}. Run \`npm run build:schemas\` first.`);
    }

    // Sort with semver semantics, then split stable from prerelease. Major and
    // minor aliases must resolve only to stable releases; prerelease directories
    // remain directly accessible by exact version.
    const semverDesc = (a: string, b: string) => semver.rcompare(a, b);

    latestStableMajor2 = versions
      .filter((v) => v.startsWith("2.") && !v.includes("-"))
      .sort(semverDesc)[0];
    latestStableMajor3 = versions
      .filter((v) => v.startsWith("3.") && !v.includes("-"))
      .sort(semverDesc)[0];
    latestPrereleaseMajor3 = versions
      .filter((v) => v.startsWith("3.") && v.includes("-"))
      .sort(semverDesc)[0];

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

    it("serves /schemas/v3/adagents.json via alias rewrite", async () => {
      if (!latestStableMajor3) return;
      const res = await request(app).get("/schemas/v3/adagents.json");
      expect(res.status).toBe(200);
    });

    it("redirects /schemas/v2/ to the resolved stable index.json", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2/");
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`/schemas/${latestStableMajor2}/index.json`);
    });

    it("redirects /schemas/v3/ to the resolved index.json", async () => {
      if (!latestStableMajor3) return;
      const res = await request(app).get("/schemas/v3/");
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`/schemas/${latestStableMajor3}/index.json`);
    });

    it("returns 404 for an alias with no matching major version", async () => {
      const res = await request(app).get("/schemas/v99/adagents.json");
      expect(res.status).toBe(404);
    });
  });

  describe("missing pinned version fallback (docs-only version bumps)", () => {
    // A docs snapshot can be cut at a version whose schema content was
    // unchanged from the last published release on the same line (e.g. a
    // 3.0.19 docs snapshot built against the existing 3.0.18 schemas), so no
    // matching schema directory is ever produced. The snapshot's link rewrite
    // still pins schema URLs to /schemas/<docs-version>/..., which must resolve
    // rather than 404.
    let missingPatch: string | undefined;
    let resolvedTarget: string | undefined;

    beforeAll(() => {
      // Synthesize a "one patch above the latest published 3.0.x" version that
      // is guaranteed not to have a directory, and compute what it should
      // resolve to (the latest published 3.0.x).
      const latest30 = versions
        .filter((v) => v.startsWith("3.0.") && !v.includes("-"))
        .sort((a, b) => semver.rcompare(a, b))[0];
      if (latest30) {
        resolvedTarget = latest30;
        const p = semver.parse(latest30)!;
        missingPatch = `${p.major}.${p.minor}.${p.patch + 1}`;
        // Guard: the synthesized version must genuinely be absent.
        if (versions.includes(missingPatch)) missingPatch = undefined;
      }
    });

    it("serves a missing pinned patch from the nearest published release on the same line", async () => {
      if (!missingPatch) return;
      const res = await request(app).get(
        `/schemas/${missingPatch}/media-buy/get-media-buy-delivery-request.json`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("marks resolved-fallback responses no-cache (the target can change as patches land)", async () => {
      if (!missingPatch) return;
      const res = await request(app).get(
        `/schemas/${missingPatch}/media-buy/get-media-buy-delivery-request.json`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
      expect(res.headers["cache-control"] ?? "").toContain("no-cache");
    });

    it("redirects a missing bare pinned directory to the resolved index.json", async () => {
      if (!missingPatch || !resolvedTarget) return;
      const res = await request(app).get(`/schemas/${missingPatch}/`);
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`/schemas/${resolvedTarget}/index.json`);
    });

    it("still 404s a pinned version with no published release in its major line", async () => {
      const res = await request(app).get("/schemas/99.9.9/adagents.json");
      expect(res.status).toBe(404);
    });
  });

  describe("cache-control policy", () => {
    // Aliases and /latest/ must force revalidation — they retarget over time,
    // and edge caches serving stale copies cause version drift for consumers
    // that fetch schemas to generate types.
    it("marks alias file responses no-cache", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2/adagents.json");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
      expect(res.headers["cache-control"] ?? "").toContain("no-cache");
    });

    it("marks minor-alias file responses no-cache", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2.5/adagents.json");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
      expect(res.headers["cache-control"] ?? "").toContain("no-cache");
    });

    it("marks /latest/ file responses no-cache", async () => {
      const res = await request(app).get("/schemas/latest/adagents.json");
      // /latest/ may or may not exist depending on build; only assert when present.
      if (res.status !== 200) return;
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
      expect(res.headers["cache-control"] ?? "").toContain("no-cache");
    });

    it("marks alias bare-directory redirects no-cache", async () => {
      if (!latestStableMajor2) return;
      const res = await request(app).get("/schemas/v2/");
      expect(res.status).toBe(302);
      expect(res.headers["cache-control"] ?? "").toContain("no-cache");
    });

    it("marks /latest/ bare-directory redirect no-cache", async () => {
      const res = await request(app).get("/schemas/latest/");
      if (res.status !== 302) return;
      expect(res.headers["cache-control"] ?? "").toContain("no-cache");
    });
  });

  describe("discovery endpoint", () => {
    it("lists versions and aliases at /schemas/", async () => {
      const res = await request(app).get("/schemas/");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.versions)).toBe(true);
      expect(Array.isArray(res.body.aliases)).toBe(true);
      expect(res.body.latest).toMatchObject({ path: "/schemas/latest/" });
      expect(res.body.latest_stable).toBe(latestStableMajor3);
      expect(res.body.aliases.find((a: { alias: string }) => a.alias === "v3")).toMatchObject({
        resolves_to: latestStableMajor3,
      });
    });
  });
});
