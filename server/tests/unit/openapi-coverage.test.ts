/**
 * Drift detection: ensures every Express route in registry-api.ts has
 * a corresponding OpenAPI registration via registry.registerPath().
 *
 * This catches the failure mode where a route handler is added without
 * documenting it in the OpenAPI spec.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_FILE = path.join(__dirname, "../../src/routes/registry-api.ts");

/**
 * Extract route registrations from source code using regex.
 * Matches: router.get("/path", ...), router.post("/path", ...)
 */
function extractExpressRoutes(source: string): Array<{ method: string; path: string }> {
  const routeRegex = /router\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;
  const routes: Array<{ method: string; path: string }> = [];
  let match;
  while ((match = routeRegex.exec(source)) !== null) {
    const raw = `/api${match[2]}`;
    routes.push({
      method: match[1],
      path: raw === "/api/" ? "/api" : raw, // normalize root path
    });
  }
  return routes;
}

/**
 * Extract OpenAPI registrations from source code using regex.
 * Matches: registry.registerPath({ method: "get", path: "/api/..." })
 */
function extractOpenApiPaths(source: string): Array<{ method: string; path: string }> {
  const pathRegex = /registry\.registerPath\(\{[\s\S]*?method:\s*["'`](\w+)["'`],\s*\n?\s*path:\s*["'`]([^"'`]+)["'`]/g;
  const paths: Array<{ method: string; path: string }> = [];
  let match;
  while ((match = pathRegex.exec(source)) !== null) {
    paths.push({
      method: match[1],
      path: match[2],
    });
  }
  return paths;
}

/** Normalize Express :param syntax to OpenAPI {param} syntax */
function normalizeParamSyntax(path: string): string {
  return path.replace(/:(\w+)/g, "{$1}");
}

describe("OpenAPI Coverage", () => {
  const source = fs.readFileSync(ROUTES_FILE, "utf-8");
  const expressRoutes = extractExpressRoutes(source);
  const openApiPaths = extractOpenApiPaths(source);

  it("should find Express routes in source", () => {
    expect(expressRoutes.length).toBeGreaterThan(0);
  });

  it("should find OpenAPI registrations in source", () => {
    expect(openApiPaths.length).toBeGreaterThan(0);
  });

  it("every Express route should have an OpenAPI registration", () => {
    const openApiSet = new Set(
      openApiPaths.map((p) => `${p.method}:${p.path}`),
    );

    const missing = expressRoutes.filter((route) => {
      const normalized = `${route.method}:${normalizeParamSyntax(route.path)}`;
      return !openApiSet.has(normalized);
    });

    if (missing.length > 0) {
      const list = missing
        .map((r) => `  ${r.method.toUpperCase()} ${r.path}`)
        .join("\n");
      throw new Error(
        `${missing.length} Express route(s) missing OpenAPI registration:\n${list}\n\n` +
          `Add registry.registerPath() calls for these routes in registry-api.ts.`,
      );
    }
  });
});
