import type { Application } from "express";
import express from "express";
import * as fs from "fs/promises";
import semver from "semver";
import { createLogger } from "./logger.js";

const logger = createLogger("schemas-middleware");

// Alias paths like "/v2/...", "/v2.5/...", "/v12/..." (v1 is a special case → latest).
const ALIAS_PATH = /^\/v(\d+)(?:\.(\d+))?(\/.*)?$/;

function isPinnedVersionPath(requestPath: string): boolean {
  // /X.Y.Z(-prerelease)?/... where the first segment is a valid semver.
  const firstSeg = requestPath.split("/")[1];
  return !!firstSeg && semver.valid(firstSeg) !== null;
}

function isPinnedTarballPath(filePath: string): boolean {
  // Match the final path component against <semver>.tgz or any of its
  // sidecar suffixes (.sha256, .sig, .crt). Pinned semver artifacts are
  // immutable once published, so they get the long immutable cache header.
  const name = filePath.split("/").pop() ?? "";
  const m = name.match(/^(.+)\.tgz(?:\.sha256|\.sig|\.crt)?$/);
  return !!m && semver.valid(m[1]) !== null;
}

function matchVersionedDir(requestPath: string): string | null {
  // Match "/<segment>/" where <segment> is either "latest" or a valid semver.
  const m = requestPath.match(/^\/([^/]+)\/$/);
  if (!m) return null;
  const seg = m[1];
  if (seg === "latest" || semver.valid(seg) !== null) return seg;
  return null;
}

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
      .filter((e) => e.isDirectory() && semver.valid(e.name) !== null)
      .map((e) => e.name)
      .sort(semver.rcompare);

    cache = { versions, timestamp: now };
    return versions;
  };
}

export function findMatchingVersion(
  versions: string[],
  requestedMajor: number,
  requestedMinor?: number,
): string | undefined {
  return versions.find((v) => {
    const parsed = semver.parse(v);
    if (!parsed) return false;
    if (parsed.major !== requestedMajor) return false;
    if (requestedMinor !== undefined && parsed.minor !== requestedMinor) return false;
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
  mountVersionedStaticRoutes(app, "/schemas", schemasPath);
}

/**
 * Mount /compliance routes: same alias + versioned-directory semantics as
 * /schemas. Serves the compliance manifest tree (universal, domains,
 * specialisms, test-kits) per AdCP release.
 */
export function mountComplianceRoutes(app: Application, compliancePath: string): void {
  mountVersionedStaticRoutes(app, "/compliance", compliancePath);
}

/**
 * Mount /protocol routes: serves the gzipped protocol tarballs
 * (/protocol/latest.tgz, /protocol/{version}.tgz) plus a discovery endpoint
 * listing available versions. No alias rewriting — clients name the exact
 * artifact they want.
 */
export function mountProtocolRoutes(app: Application, protocolPath: string): void {
  app.get("/protocol/", async (_req, res) => {
    try {
      const entries = await fs.readdir(protocolPath, { withFileTypes: true });
      const tarballs = entries
        .filter(
          (e) =>
            e.isFile() &&
            e.name.endsWith(".tgz") &&
            (e.name === "latest.tgz" ||
              semver.valid(e.name.replace(/\.tgz$/, "")) !== null),
        )
        .map((e) => e.name);

      const versioned = tarballs
        .filter((name) => name !== "latest.tgz")
        .sort((a, b) => semver.rcompare(a.replace(/\.tgz$/, ""), b.replace(/\.tgz$/, "")));

      const sidecarFiles = new Set(
        entries.filter((e) => e.isFile()).map((e) => e.name),
      );
      const sidecarsFor = (tarballName: string) => {
        const sigName = `${tarballName}.sig`;
        const crtName = `${tarballName}.crt`;
        return {
          signature: sidecarFiles.has(sigName)
            ? `/protocol/${sigName}`
            : undefined,
          certificate: sidecarFiles.has(crtName)
            ? `/protocol/${crtName}`
            : undefined,
        };
      };

      let latestBlock: {
        tarball: string;
        checksum: string;
        signature?: string;
        certificate?: string;
        adcp_version?: string;
        generated_at?: string;
        note: string;
      } | null = null;
      if (tarballs.includes("latest.tgz")) {
        const latestPath = `${protocolPath}/latest.tgz`;
        let generatedAt: string | undefined;
        try {
          const stat = await fs.stat(latestPath);
          generatedAt = stat.mtime.toISOString();
        } catch {
          // ignore — absent file is already handled upstream
        }
        const latestSidecars = sidecarsFor("latest.tgz");
        latestBlock = {
          tarball: "/protocol/latest.tgz",
          checksum: "/protocol/latest.tgz.sha256",
          ...(latestSidecars.signature && { signature: latestSidecars.signature }),
          ...(latestSidecars.certificate && { certificate: latestSidecars.certificate }),
          adcp_version: versioned[0]?.replace(/\.tgz$/, ""),
          generated_at: generatedAt,
          note: "Development bundle — changes with every merge. Pin a version for production.",
        };
      }

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json({
        generated_at: new Date().toISOString(),
        signature_verification: {
          tool: "cosign verify-blob",
          certificate_identity_regexp:
            "^https://github\\.com/adcontextprotocol/adcp/\\.github/workflows/release\\.yml@refs/heads/.*$",
          certificate_oidc_issuer: "https://token.actions.githubusercontent.com",
          docs: "/docs/building/schemas-and-sdks#verifying-protocol-bundle-signatures",
        },
        versions: versioned.map((name) => {
          const sidecars = sidecarsFor(name);
          return {
            version: name.replace(/\.tgz$/, ""),
            tarball: `/protocol/${name}`,
            checksum: `/protocol/${name}.sha256`,
            ...(sidecars.signature && { signature: sidecars.signature }),
            ...(sidecars.certificate && { certificate: sidecars.certificate }),
          };
        }),
        latest: latestBlock,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to list protocol tarballs");
      res.status(500).json({ error: "Failed to list protocol tarballs" });
    }
  });

  app.use(
    "/protocol",
    express.static(protocolPath, {
      maxAge: "10m",
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (filePath.endsWith(".tgz")) {
          res.setHeader("Content-Type", "application/gzip");
        } else if (filePath.endsWith(".sha256")) {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
        } else if (filePath.endsWith(".sig")) {
          res.setHeader("Content-Type", "application/octet-stream");
        } else if (filePath.endsWith(".crt")) {
          res.setHeader("Content-Type", "application/x-pem-file");
        }
        if (isPinnedTarballPath(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
}

function mountVersionedStaticRoutes(
  app: Application,
  mountPath: string,
  rootPath: string,
): void {
  const getSchemaVersions = makeVersionCache(rootPath);

  const schemasStatic = express.static(rootPath, {
    maxAge: "10m",
    etag: true,
    lastModified: true,
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  });

  app.use(mountPath, async (req, res, next) => {
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

    // 2. Set cache-control based on the original request path:
    //    - Pinned semver (client asked for an immutable version): 1-year immutable.
    //    - /latest/ and aliases (/v2, /v2.5, ...): no-cache + ETag, so shared
    //      caches revalidate on every request and pick up retargeting immediately.
    //      Without this, edge caches can serve different versions from different
    //      POPs within their TTL window and cause drift for consumers generating
    //      types from the schemas.
    if (!isAlias && isPinnedVersionPath(originalPath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, no-cache, must-revalidate");
    }

    // 3. Redirect bare version directories to their index.json.
    if (matchVersionedDir(req.path)) {
      return res.redirect(mountPath + req.path + "index.json");
    }

    schemasStatic(req, res, next);
  });

  app.get(mountPath + "/", async (_req, res) => {
    try {
      const versions = await getSchemaVersions();
      const latestPerMinor: Record<string, string> = {};
      let latestMajorVersion: string | undefined;

      for (const version of versions) {
        const parsed = semver.parse(version);
        if (!parsed) continue;
        const minorKey = `${parsed.major}.${parsed.minor}`;
        if (!latestMajorVersion) latestMajorVersion = version;
        if (!latestPerMinor[minorKey]) latestPerMinor[minorKey] = version;
      }

      const aliases: Array<{
        alias: string;
        resolves_to: string;
        path: string;
      }> = [];

      if (latestMajorVersion) {
        const major = semver.parse(latestMajorVersion)?.major;
        if (major !== undefined) {
          aliases.push({
            alias: `v${major}`,
            resolves_to: latestMajorVersion,
            path: `${mountPath}/v${major}/`,
          });
        }
      }

      for (const [minorKey, version] of Object.entries(latestPerMinor)) {
        aliases.push({
          alias: `v${minorKey}`,
          resolves_to: version,
          path: `${mountPath}/v${minorKey}/`,
        });
      }

      aliases.sort((a, b) =>
        a.alias.localeCompare(b.alias, undefined, { numeric: true }),
      );

      res.json({
        versions: versions.map((v) => ({ version: v, path: `${mountPath}/${v}/` })),
        aliases,
        latest: {
          path: `${mountPath}/latest/`,
          note: "Development version, may differ from released versions",
        },
      });
    } catch (error) {
      logger.error({ err: error, mountPath }, "Failed to list versions");
      res.status(500).json({ error: "Failed to list versions" });
    }
  });
}
