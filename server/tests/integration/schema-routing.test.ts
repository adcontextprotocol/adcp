import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import semver from "semver";
import {
  mountComplianceRoutes,
  mountProtocolRoutes,
  mountSchemasRoutes,
  resolvePinnedFallback as resolveFlyFallback,
} from "../../src/schemas-middleware.js";
import {
  clearVersionCacheForTests,
  handleRequest,
  resolvePinnedFallback as resolveWorkerFallback,
} from "../../../workers/artifact-cdn/src/index.js";

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
      .filter((v) => v.startsWith("3.") && !v.includes("-") && !["3.1.3", "3.2.0"].includes(v))
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
    it("skips withdrawn releases while preserving their exact immutable paths", async () => {
      const tempSchemasPath = fs.mkdtempSync(path.join(os.tmpdir(), "schema-routing-withdrawn-"));

      try {
        for (const version of ["3.1.2", "3.1.3", "3.2.0"]) {
          fs.mkdirSync(path.join(tempSchemasPath, version), { recursive: true });
          fs.writeFileSync(
            path.join(tempSchemasPath, version, "index.json"),
            JSON.stringify({ version }),
          );
          fs.writeFileSync(
            path.join(tempSchemasPath, version, "product.json"),
            JSON.stringify({ version }),
          );
        }

        const tempApp = express();
        mountSchemasRoutes(tempApp, tempSchemasPath);

        const alias = await request(tempApp).get("/schemas/v3.1/product.json");
        expect(alias.status).toBe(200);
        expect(alias.body.version).toBe("3.1.2");

        const exact = await request(tempApp).get("/schemas/3.1.3/product.json");
        expect(exact.status).toBe(200);
        expect(exact.body.version).toBe("3.1.3");
        expect(exact.headers["cache-control"]).toContain("immutable");

        const discovery = await request(tempApp).get("/schemas/");
        expect(discovery.body.latest_stable).toBe("3.1.2");
        expect(discovery.body.aliases).toContainEqual({
          alias: "v3.1",
          resolves_to: "3.1.2",
          path: "/schemas/v3.1/",
        });
        expect(discovery.body.versions).toContainEqual(expect.objectContaining({
          version: "3.1.3",
          stability: "withdrawn",
          deprecated: true,
          withdrawn: true,
        }));
        expect(discovery.body.versions).toContainEqual(expect.objectContaining({
          version: "3.2.0",
          stability: "unpublished",
          deprecated: false,
          published: false,
        }));
      } finally {
        fs.rmSync(tempSchemasPath, { recursive: true, force: true });
      }
    });

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

      const discovery = await request(app).get("/schemas/");
      expect(discovery.body.versions).toContainEqual(expect.objectContaining({
        version: latestStableMajor2,
        deprecated: true,
      }));
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

  describe("legacy Trusted Match schema namespace", () => {
    it("serves legacy /tmp/ schema URLs from /latest/ via the canonical trusted-match files", async () => {
      const tempSchemasPath = fs.mkdtempSync(path.join(os.tmpdir(), "schema-routing-"));

      try {
        fs.mkdirSync(path.join(tempSchemasPath, "latest", "trusted-match"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(tempSchemasPath, "latest", "trusted-match", "context-match-request.json"),
          JSON.stringify({
            $id: "/schemas/latest/trusted-match/context-match-request.json",
          }),
        );

        const tempApp = express();
        mountSchemasRoutes(tempApp, tempSchemasPath);

        const res = await request(tempApp).get(
          "/schemas/latest/tmp/context-match-request.json",
        );
        expect(res.status).toBe(200);
        expect(res.body.$id).toBe("/schemas/latest/trusted-match/context-match-request.json");
        expect(res.headers["cache-control"] ?? "").toContain("no-cache");
      } finally {
        fs.rmSync(tempSchemasPath, { recursive: true, force: true });
      }
    });

    it("keeps exact pinned /tmp/ schema artifacts authoritative when present", async () => {
      const res = await request(app).get("/schemas/3.1.0/tmp/context-match-request.json");
      expect(res.status).toBe(200);
      expect(res.body.$id).toBe("/schemas/3.1.0/tmp/context-match-request.json");
      expect(res.headers["cache-control"] ?? "").toContain("immutable");
    });

    it("keeps resolved pinned /tmp/ schema artifacts authoritative when present", async () => {
      const tempSchemasPath = fs.mkdtempSync(path.join(os.tmpdir(), "schema-routing-"));

      try {
        fs.mkdirSync(path.join(tempSchemasPath, "3.1.0", "tmp"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(tempSchemasPath, "3.1.0", "tmp", "offer.json"),
          JSON.stringify({
            $id: "/schemas/3.1.0/tmp/offer.json",
          }),
        );

        const tempApp = express();
        mountSchemasRoutes(tempApp, tempSchemasPath);

        const res = await request(tempApp).get("/schemas/3.1.1/tmp/offer.json");
        expect(res.status).toBe(200);
        expect(res.body.$id).toBe("/schemas/3.1.0/tmp/offer.json");
        expect(res.headers["cache-control"] ?? "").toContain("no-cache");
      } finally {
        fs.rmSync(tempSchemasPath, { recursive: true, force: true });
      }
    });

    it("falls back an exact pinned /tmp/ URL when the release only has trusted-match files", async () => {
      const tempSchemasPath = fs.mkdtempSync(path.join(os.tmpdir(), "schema-routing-"));
      const version = "9.9.9";

      try {
        fs.mkdirSync(path.join(tempSchemasPath, version, "trusted-match"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(tempSchemasPath, version, "trusted-match", "context-match-request.json"),
          JSON.stringify({
            $id: `/schemas/${version}/trusted-match/context-match-request.json`,
          }),
        );

        const tempApp = express();
        mountSchemasRoutes(tempApp, tempSchemasPath);

        const res = await request(tempApp).get(
          `/schemas/${version}/tmp/context-match-request.json`,
        );
        expect(res.status).toBe(200);
        expect(res.body.$id).toBe(
          `/schemas/${version}/trusted-match/context-match-request.json`,
        );
        expect(res.headers["cache-control"] ?? "").toContain("immutable");
      } finally {
        fs.rmSync(tempSchemasPath, { recursive: true, force: true });
      }
    });

    it.each([
      "/schemas/latest/tmp/../../../../etc/passwd",
      "/schemas/latest/tmp/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
      "/schemas/latest/core/tmp/context-match-request.json",
    ])("does not rewrite malformed legacy /tmp/ path %s", async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
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

describe("/protocol discovery release overrides", () => {
  it("selects the supported release while retaining withdrawn and unpublished artifacts", async () => {
    const protocolPath = fs.mkdtempSync(path.join(os.tmpdir(), "protocol-routing-overrides-"));

    try {
      for (const version of ["3.1.2", "3.1.3", "3.2.0"]) {
        fs.writeFileSync(path.join(protocolPath, `${version}.tgz`), version);
        fs.writeFileSync(path.join(protocolPath, `${version}.tgz.sha256`), `${version}-checksum`);
      }
      fs.writeFileSync(path.join(protocolPath, "latest.tgz"), "latest");
      fs.writeFileSync(path.join(protocolPath, "latest.tgz.sha256"), "latest-checksum");

      const app = express();
      mountProtocolRoutes(app, protocolPath);

      const discovery = await request(app).get("/protocol/");
      expect(discovery.status).toBe(200);
      expect(discovery.body.latest.published_version).toBe("3.1.2");
      expect(discovery.body.versions).toContainEqual(expect.objectContaining({
        version: "3.1.3",
        stability: "withdrawn",
        deprecated: true,
        withdrawn: true,
      }));
      expect(discovery.body.versions).toContainEqual(expect.objectContaining({
        version: "3.2.0",
        stability: "unpublished",
        deprecated: false,
        published: false,
      }));

      const exact = await request(app).get("/protocol/3.1.3.tgz");
      expect(exact.status).toBe(200);
      expect(exact.body.toString()).toBe("3.1.3");
      expect(exact.headers["cache-control"]).toContain("immutable");
    } finally {
      fs.rmSync(protocolPath, { recursive: true, force: true });
    }
  });
});

describe("Worker and Fly artifact routing parity", () => {
  const mounts = ["schemas", "compliance"] as const;
  const methods = ["GET", "HEAD"] as const;
  const immutable = "public, max-age=31536000, immutable";
  const revalidate = "public, no-cache, must-revalidate";
  const versions = ["2.9.9", "3.0.18", "3.0.20", "3.1.4", "3.2.0-rc.3", "3.2.0-rc.3+build.7", "3.4.0", "5.0.0-rc.3"];
  const objects = new Map<string, string>();
  let fixtureRoot: string;
  let app: express.Express;
  let appWithFallback: express.Express;

  // Only the R2 storage boundary is faked. Both production routers serve the
  // same tiny fixture tree, without building or changing released artifacts.
  const bucket = {
    async list({ prefix, delimiter }: { prefix: string; delimiter?: string }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return {
        objects: keys.map((key) => ({ key })),
        delimitedPrefixes: delimiter
          ? [...new Set(keys.map((key) => prefix + key.slice(prefix.length).split("/")[0] + "/"))]
          : [],
        truncated: false,
      };
    },
    async get(key: string) {
      const body = objects.get(key);
      return body === undefined ? null : { body, httpEtag: '"fixture"' };
    },
    async head(key: string) {
      return this.get(key);
    },
  };

  beforeAll(() => {
    clearVersionCacheForTests();
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-routing-parity-"));
    const add = (key: string, body: string) => {
      objects.set(key, body);
      const filename = path.join(fixtureRoot, key);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, body);
    };
    for (const mount of mounts) {
      for (const version of [...versions, "latest"]) {
        for (const filename of ["artifact.json", "index.json", "nested/index.json", "nested/artifact.json"]) {
          add(`${mount}/${version}/${filename}`, JSON.stringify({ version, filename }));
        }
      }
      add(`${mount}/latest/candidate-only.json`, JSON.stringify({ version: "latest" }));
    }
    for (const version of ["3.1.4", "3.2.0-rc.3", "latest"]) {
      for (const suffix of ["", ".sha256", ".sig", ".crt"]) {
        add(`protocol/${version}.tgz${suffix}`, `${version}${suffix}`);
      }
    }
    app = express();
    mountSchemasRoutes(app, path.join(fixtureRoot, "schemas"));
    mountComplianceRoutes(app, path.join(fixtureRoot, "compliance"));
    mountProtocolRoutes(app, path.join(fixtureRoot, "protocol"));
    appWithFallback = express();
    mountSchemasRoutes(appWithFallback, path.join(fixtureRoot, "schemas"));
    mountComplianceRoutes(appWithFallback, path.join(fixtureRoot, "compliance"));
    appWithFallback.use((_req, res) => res.json({ version: "older" }));
  });

  afterAll(() => {
    clearVersionCacheForTests();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const clients = {
    Worker: async (url: string, method: "GET" | "HEAD") => {
      const response = await handleRequest(new Request(`https://artifacts.example${url}`, { method }), { ARTIFACTS: bucket });
      return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() };
    },
    Fly: async (url: string, method: "GET" | "HEAD") => {
      const response = await (method === "HEAD" ? request(app).head(url) : request(app).get(url));
      return { status: response.status, headers: response.headers, text: response.text ?? (method === "HEAD" ? "" : response.body.toString()) };
    },
  };

  for (const [runtime, get] of Object.entries(clients)) {
    describe(runtime, () => {
      for (const mount of mounts) {
        describe(`/${mount}`, () => {
          it.each(methods)("%s serves exact prerelease files and directory forms with immutable caching", async (method) => {
            for (const version of ["3.2.0-rc.3", "3.2.0-rc.3+build.7"]) {
              for (const [suffix, status, location] of [
                ["/artifact.json", 200, undefined],
                ["/index.json", 200, undefined],
                ["", 301, `/${mount}/${version}/`],
                ["/", 302, `/${mount}/${version}/index.json`],
              ] as const) {
                const response = await get(`/${mount}/${version}${suffix}`, method);
                expect(response.status, suffix).toBe(status);
                expect(response.headers.location, suffix).toBe(location);
                expect(response.headers["cache-control"], suffix).toBe(immutable);
                if (method === "GET" && status === 200) expect(JSON.parse(response.text).version).toBe(version);
                if (method === "HEAD") expect(response.text).toBe("");
              }
            }
          });

          it.each(methods)("%s denies every absent prerelease form before fallback or directory redirects", async (method) => {
            for (const version of ["3.2.0-rc.4", "3.5.0-rc.1", "3.2.0-rc.4+build.7", "3.2.0-rc.3+missing", "v3.2.0-rc.4", "v3.2.0-rc.3"]) {
              for (const suffix of ["", "/", "/artifact.json", "/index.json", "/nested", "/nested/", "/nested/index.json", "/nested/artifact.json", "/candidate-only.json"]) {
                const url = `/${mount}/${version}${suffix}`;
                const response = await get(url, method);
                expect(response.status, url).toBe(404);
                expect(response.headers.location, url).toBeUndefined();
                expect(response.headers["cache-control"], url).toBe("no-store");
                expect(response.headers.etag, url).toBeUndefined();
                expect(response.text, url).toBe(method === "HEAD" ? "" : "Not Found");
              }
            }
          });

          it.each(methods)("%s keeps candidate-only files absent even under an exact published prerelease", async (method) => {
            const url = `/${mount}/3.2.0-rc.3/candidate-only.json`;
            const response = runtime === "Fly"
              ? await (method === "HEAD" ? request(appWithFallback).head(url) : request(appWithFallback).get(url))
              : await get(url, method);
            expect(response.status).toBe(404);
            expect(response.headers.location).toBeUndefined();
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers.etag).toBeUndefined();
            expect(response.text ?? "").toBe(method === "HEAD" ? "" : "Not Found");
          });

          it("lists only stored versions and stable aliases, omitting the unpublished candidate", async () => {
            const response = await get(`/${mount}/`, "GET");
            expect(response.status).toBe(200);
            const discovery = JSON.parse(response.text);
            expect(discovery.versions.map((entry: { version: string }) => entry.version).sort()).toEqual([...versions].sort());
            expect(discovery.aliases.every((entry: { resolves_to: string }) => versions.includes(entry.resolves_to) && !entry.resolves_to.includes("-"))).toBe(true);
            expect(discovery.latest_stable).toBe("3.4.0");
            expect(discovery.latest.path).toBe(`/${mount}/latest/`);
            expect(response.text).not.toContain("3.2.0-rc.4");
          });

          it.each(methods)("%s limits stable docs-gap fallback to schemas", async (method) => {
            for (const [pin, target] of [["3.0.19", "3.0.18"], ["3.3.0", "3.1.4"]]) {
              for (const suffix of ["", "/", "/artifact.json", "/index.json"]) {
                const response = await get(`/${mount}/${pin}${suffix}`, method);
                if (mount === "schemas") {
                  expect(response.status, pin + suffix).toBe(suffix === "" ? 301 : suffix === "/" ? 302 : 200);
                  expect(response.headers["cache-control"], pin + suffix).toBe(revalidate);
                  if (suffix === "") expect(response.headers.location, pin).toBe(`/${mount}/${target}/`);
                  else if (suffix === "/") expect(response.headers.location, pin).toBe(`/${mount}/${target}/index.json`);
                  else if (method === "GET") expect(JSON.parse(response.text).version, pin).toBe(target);
                } else {
                  expect(response.status, pin + suffix).toBe(404);
                  expect(response.headers.location, pin + suffix).toBeUndefined();
                  expect(response.headers["cache-control"], pin + suffix).toBe("no-store");
                }
              }
            }
            for (const pin of ["3.0.1", "4.0.0", "5.0.0"]) {
              const response = await get(`/${mount}/${pin}/artifact.json`, method);
              expect(response.status, pin).toBe(404);
              expect(response.headers.location, pin).toBeUndefined();
            }
          });

          it.each(methods)("%s does not resolve malformed versions", async (method) => {
            for (const version of ["3.2", "3.2.0junk", "03.2.0", "3.2.0-rc.04", "3.2.0-rc..4", "3.2.0-rc.4+"]) {
              for (const suffix of ["", "/", "/artifact.json", "/index.json"]) {
                const response = await get(`/${mount}/${version}${suffix}`, method);
                expect(response.status, version + suffix).toBe(404);
                expect(response.headers.location, version + suffix).toBeUndefined();
              }
            }
          });

          it("keeps stable aliases and latest mutable", async () => {
            for (const [alias, target] of [["v3", "3.4.0"], ["v3.0", "3.0.20"], ["latest", "latest"], ["v1", "latest"]]) {
              const response = await get(`/${mount}/${alias}/artifact.json`, "GET");
              expect(response.status, alias).toBe(200);
              expect(JSON.parse(response.text).version, alias).toBe(target);
              expect(response.headers["cache-control"], alias).toBe(revalidate);
            }
          });
        });
      }

      it.each(methods)("%s leaves exact protocol artifacts and absent protocol versions unchanged", async (method) => {
        for (const suffix of ["", ".sha256", ".sig", ".crt"]) {
          const exact = await get(`/protocol/3.2.0-rc.3.tgz${suffix}`, method);
          expect(exact.status, suffix).toBe(200);
          // Protocol cache policies already differ between hosts; this fix
          // must leave those tarball and sidecar policies untouched.
          expect(exact.headers["cache-control"], suffix).toBe(suffix && runtime === "Worker" ? revalidate : immutable);
          if (method === "GET") expect(exact.text, suffix).toBe(`3.2.0-rc.3${suffix}`);
          for (const missing of ["3.2.0-rc.4", "3.1.5"]) {
            const response = await get(`/protocol/${missing}.tgz${suffix}`, method);
            expect(response.status, missing + suffix).toBe(404);
            expect(response.headers.location).toBeUndefined();
          }
        }
        for (const url of ["/protocol/3.2.0-rc.4", "/protocol/3.2.0-rc.4/", "/protocol/v3.tgz"]) {
          expect((await get(url, method)).status, url).toBe(404);
        }
        const latest = await get("/protocol/latest.tgz", method);
        expect(latest.status).toBe(200);
        expect(latest.headers["cache-control"]).toBe(runtime === "Worker" ? revalidate : "public, max-age=600");
        if (method === "GET") expect(latest.text).toBe("latest");
      });

      it("keeps protocol discovery based on exact tarballs", async () => {
        const response = await get("/protocol/", "GET");
        expect(response.status).toBe(200);
        const discovery = JSON.parse(response.text);
        expect(discovery.versions.map((entry: { version: string }) => entry.version)).toEqual(["3.2.0-rc.3", "3.1.4"]);
        expect(discovery.latest.published_version).toBe("3.2.0-rc.3");
        expect(response.text).not.toContain("3.2.0-rc.4");
      });
    });
  }

  it("denies absent prereleases without exposing failed version-listing details", async () => {
    clearVersionCacheForTests();
    const unavailableApp = express();
    mountSchemasRoutes(unavailableApp, path.join(fixtureRoot, "missing-schemas"));
    mountComplianceRoutes(unavailableApp, path.join(fixtureRoot, "missing-compliance"));
    let listCalls = 0;
    const unavailableBucket = {
      ...bucket,
      async list() {
        listCalls += 1;
        throw new Error("Private bucket listing credentials unavailable");
      },
    };
    for (const mount of mounts) {
      for (const method of methods) {
        for (const suffix of ["", "/", "/artifact.json", "/index.json"]) {
          const url = `/${mount}/3.2.0-rc.4${suffix}`;
          const worker = await handleRequest(new Request(`https://artifacts.example${url}`, { method }), { ARTIFACTS: unavailableBucket });
          const fly = await (method === "HEAD" ? request(unavailableApp).head(url) : request(unavailableApp).get(url));
          for (const response of [
            { status: worker.status, headers: Object.fromEntries(worker.headers), text: await worker.text() },
            { status: fly.status, headers: fly.headers, text: fly.text ?? "" },
          ]) {
            expect(response.status, url).toBe(404);
            expect(response.headers["cache-control"], url).toBe("no-store");
            expect(response.headers.location, url).toBeUndefined();
            expect(response.headers.etag, url).toBeUndefined();
            expect(response.text, url).toBe(method === "HEAD" ? "" : "Not Found");
          }
        }
      }
    }
    expect(listCalls).toBe(16);
  });

  it.each([
    ["3.2.0-rc.4", ["3.2.0-rc.3", "3.1.4"], undefined],
    ["v3.2.0-rc.4", ["3.2.0-rc.3", "3.1.4"], undefined],
    ["3.2.0-rc.4+build.7", ["3.2.0-rc.3+build.7"], undefined],
    ["3.5.0-rc.1", ["3.4.0"], undefined],
    ["3.0.19", ["3.0.20", "3.1.4", "3.0.18"], "3.0.18"],
    ["3.0.19+build-rc.4", ["3.0.18"], "3.0.18"],
    ["3.3.0", ["3.4.0", "3.2.0-rc.3", "3.1.4"], "3.1.4"],
    ["3.0.1", ["2.9.9", "3.0.18"], undefined],
    ["4.0.0", ["3.4.0", "5.0.0"], undefined],
    ["5.0.0", ["5.0.0-rc.3"], undefined],
    ["3.1.5", ["3.1.3", "3.1.2"], "3.1.2"],
    ["3.2.1", ["3.2.0", "3.1.4"], "3.1.4"],
    ["3.2", ["3.1.4"], undefined],
    ["3.2.0junk", ["3.1.4"], undefined],
    ["03.2.0", ["3.1.4"], undefined],
    ["3.2.0-rc.04", ["3.1.4"], undefined],
    ["3.2.0-rc..4", ["3.1.4"], undefined],
    ["3.2.0-rc.4+", ["3.1.4"], undefined],
  ] as const)("production resolvers agree for %s with %j", (requested, published, expected) => {
    expect(resolveWorkerFallback([...published], requested)).toBe(expected);
    expect(resolveFlyFallback([...published], requested)).toBe(expected);
  });
});
