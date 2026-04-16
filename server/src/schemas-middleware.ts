import type { Application } from "express";
import express from "express";
import * as fs from "fs/promises";
import { createLogger } from "./logger.js";

const logger = createLogger("schemas-middleware");

// Bare version directory requests (/2.5.3/, /3.0.0-rc.3/, /latest/).
const VERSIONED_DIR = /^\/(\d+\.\d+\.\d+(?:-[a-zA-Z]+\.\d+)?|latest)\/$/;
// Alias paths like "/v2/...", "/v2.5/...", "/v12/..." (v1 is a special case → latest).
const ALIAS_PATH = /^\/v(\d+)(?:\.(\d+))?(\/.*)?$/;
// Direct versioned paths (/2.5.3/..., /3.0.0-rc.3/...) — immutable.
const IMMUTABLE_PATH = /^\/\d+\.\d+\.\d+(-[a-zA-Z]+\.\d+)?\//;

/**
 * Cache of versioned schema directories, refreshed every 60 seconds.
 * Scoped per-call so each mount has its own cache.
 */
function makeVersionCache(schemasPath: string) {
  let cache: { versions: string[]; timestamp: number } | null = null;
  const CACHE_TTL_MS = 60 * 1000;

  return async function getSchemaVersions(): Promise<string[]> {
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL_MS) return cache.versions;

    const entries = await fs.readdir(schemasPath, { withFileTypes: true });
    const versions = entries
      .filter(
        (e) =>
          e.isDirectory() && /^\d+\.\d+\.\d+(-[a-zA-Z]+\.\d+)?$/.test(e.name),
      )
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = parseSemver(a);
        const pb = parseSemver(b);
        if (pa.major !== pb.major) return pb.major - pa.major;
        if (pa.minor !== pb.minor) return pb.minor - pa.minor;
        if (pa.patch !== pb.patch) return pb.patch - pa.patch;
        // Stable beats prerelease for the same base version.
        if (!pa.prerelease && pb.prerelease) return -1;
        if (pa.prerelease && !pb.prerelease) return 1;
        if (pa.prerelease && pb.prerelease)
          return pb.prerelease.localeCompare(pa.prerelease);
        return 0;
      });

    cache = { versions, timestamp: now };
    return versions;
  };
}

export function parseSemver(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
} {
  const [base, prerelease] = version.split("-");
  const [major, minor, patch] = base.split(".").map(Number);
  return { major, minor, patch, prerelease };
}

export function findMatchingVersion(
  versions: string[],
  requestedMajor: number,
  requestedMinor?: number,
): string | undefined {
  return versions.find((v) => {
    const { major, minor } = parseSemver(v);
    if (major !== requestedMajor) return false;
    if (requestedMinor !== undefined && minor !== requestedMinor) return false;
    return true;
  });
}

/**
 * Mount /schemas routes on the given Express app:
 *  - rewrites version-alias paths (/v2, /v2.5, /v3, /v12, ...) to a concrete version directory
 *  - redirects bare version directories (/2.5.3/, /3.0.0-rc.3/, /latest/) to index.json
 *  - serves JSON schemas from `schemasPath` with per-path cache-control
 *  - exposes a /schemas/ discovery endpoint listing versions and aliases
 *
 * Mounted before body-parsing / cookie / CSRF middleware so schema reads stay cheap.
 */
export function mountSchemasRoutes(app: Application, schemasPath: string): void {
  const getSchemaVersions = makeVersionCache(schemasPath);

  const schemasStatic = express.static(schemasPath, {
    maxAge: "10m",
    etag: true,
    lastModified: true,
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  });

  app.use("/schemas", async (req, res, next) => {
    // Capture before any rewrite — caches key on the original URL, so the
    // immutable-cache decision must be based on what the client requested.
    const originalPath = req.path;
    const isAlias = ALIAS_PATH.test(originalPath);

    // 1. Rewrite alias paths to a concrete version directory.
    if (isAlias) {
      const aliasMatch = originalPath.match(ALIAS_PATH)!;
      const requestedMajor = parseInt(aliasMatch[1], 10);
      const requestedMinor = aliasMatch[2]
        ? parseInt(aliasMatch[2], 10)
        : undefined;
      const restOfPath = aliasMatch[3] || "/";

      if (requestedMajor === 1 && requestedMinor === undefined) {
        req.url = "/latest" + restOfPath;
      } else {
        try {
          const versions = await getSchemaVersions();
          const targetVersion = findMatchingVersion(
            versions,
            requestedMajor,
            requestedMinor,
          );
          if (targetVersion) {
            req.url = "/" + targetVersion + restOfPath;
          }
        } catch {
          // Fall through; static handler below will produce the 404.
        }
      }
    }

    // 2. Redirect bare version directories to their index.json.
    if (VERSIONED_DIR.test(req.path)) {
      return res.redirect("/schemas" + req.path + "index.json");
    }

    // 3. Only direct versioned paths (client pinned a full semver) are immutable.
    //    Aliases and /latest/ keep the static 10m + ETag default so caches
    //    revalidate when the alias retargets to a new version.
    if (!isAlias && IMMUTABLE_PATH.test(originalPath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }

    schemasStatic(req, res, next);
  });

  app.get("/schemas/", async (_req, res) => {
    try {
      const versions = await getSchemaVersions();
      const latestPerMinor: Record<string, string> = {};
      let latestMajorVersion: string | undefined;

      for (const version of versions) {
        const { major, minor } = parseSemver(version);
        const minorKey = `${major}.${minor}`;
        if (!latestMajorVersion) latestMajorVersion = version;
        if (!latestPerMinor[minorKey]) latestPerMinor[minorKey] = version;
      }

      const aliases: Array<{
        alias: string;
        resolves_to: string;
        path: string;
      }> = [];

      if (latestMajorVersion) {
        const { major } = parseSemver(latestMajorVersion);
        aliases.push({
          alias: `v${major}`,
          resolves_to: latestMajorVersion,
          path: `/schemas/v${major}/`,
        });
      }

      for (const [minorKey, version] of Object.entries(latestPerMinor)) {
        aliases.push({
          alias: `v${minorKey}`,
          resolves_to: version,
          path: `/schemas/v${minorKey}/`,
        });
      }

      aliases.sort((a, b) =>
        a.alias.localeCompare(b.alias, undefined, { numeric: true }),
      );

      res.json({
        versions: versions.map((v) => ({ version: v, path: `/schemas/${v}/` })),
        aliases,
        latest: {
          path: "/schemas/latest/",
          note: "Development version, may differ from released versions",
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to list schema versions");
      res.status(500).json({ error: "Failed to list schema versions" });
    }
  });
}
