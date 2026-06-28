import type { Application } from "express";
import express from "express";
import * as fs from "fs/promises";
import semver from "semver";
import { createLogger } from "./logger.js";

const logger = createLogger("schemas-middleware");

// Alias paths like "/v2/...", "/v2.5/...", "/v12/..." (v1 is a special case → latest).
const ALIAS_PATH = /^\/v(\d+)(?:\.(\d+))?(\/.*)?$/;
const LEGACY_TMP_SCHEMA_PATH =
  /^\/(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/tmp\/([A-Za-z0-9._-]+\.json)$/;
const TRUSTED_MATCH_SCHEMA_FILENAMES = [
  "available-package.json",
  "context-match-request.json",
  "context-match-response.json",
  "error.json",
  "identity-match-request.json",
  "identity-match-response.json",
  "offer-price.json",
  "offer.json",
  "provider-registration.json",
] as const;

type TrustedMatchSchemaFilename = (typeof TRUSTED_MATCH_SCHEMA_FILENAMES)[number];

type LegacyTmpSchemaPath = {
  version: string;
  filename: TrustedMatchSchemaFilename;
  trustedMatchPath: string;
};

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
    if (parsed.prerelease.length > 0) return false;
    if (parsed.major !== requestedMajor) return false;
    if (requestedMinor !== undefined && parsed.minor !== requestedMinor) return false;
    return true;
  });
}

function latestStableVersion(versions: string[]): string | null {
  return versions.find((v) => {
    const parsed = semver.parse(v);
    return parsed && parsed.prerelease.length === 0;
  }) ?? null;
}

function legacyTmpPathInfo(requestPath: string): LegacyTmpSchemaPath | null {
  const match = requestPath.match(LEGACY_TMP_SCHEMA_PATH);
  if (!match) return null;
  const [, version, filename] = match;
  const trustedMatchFilename = TRUSTED_MATCH_SCHEMA_FILENAMES.find(
    (candidate) => candidate === filename,
  );
  if (!trustedMatchFilename) return null;
  return {
    version,
    filename: trustedMatchFilename,
    trustedMatchPath: `/${version}/trusted-match/${trustedMatchFilename}`,
  };
}

async function legacyTmpSchemaFileExists(
  rootPath: string,
  version: string,
  filename: TrustedMatchSchemaFilename,
): Promise<boolean> {
  if (semver.valid(version) === null) return false;

  try {
    const stat = await fs.stat(`${rootPath}/${version}/tmp/${filename}`);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function legacyTmpSchemaFileExistsForPath(
  rootPath: string,
  getSchemaVersions: () => Promise<string[]>,
  legacyPath: LegacyTmpSchemaPath,
): Promise<boolean> {
  if (legacyPath.version === "latest") return false;

  try {
    const versions = await getSchemaVersions();
    const resolvedVersion = versions.find((version) => version === legacyPath.version);
    return resolvedVersion
      ? legacyTmpSchemaFileExists(rootPath, resolvedVersion, legacyPath.filename)
      : false;
  } catch {
    return false;
  }
}

function versionEntry(version: string, mountPath: string) {
  const parsed = semver.parse(version);
  const prerelease = !!parsed && parsed.prerelease.length > 0;
  const label = prerelease ? String(parsed.prerelease[0]).toLowerCase() : "";
  return {
    version,
    stability: prerelease
      ? (label === "rc" || label === "beta" ? label : "prerelease")
      : "stable",
    prerelease,
    deprecated: false,
    path: `${mountPath}/${version}/`,
  };
}

/**
 * Resolve a pinned semver path whose exact version directory does NOT exist to
 * the nearest published release it should map to.
 *
 * This covers docs-only version bumps: when a docs snapshot is cut at a version
 * whose schema content was unchanged from the last published release on the
 * same line (e.g. a 3.0.19 docs snapshot built against the existing 3.0.18
 * schemas), no 3.0.19 schema directory is ever produced. The snapshot's link
 * rewrite still pins schema URLs to /schemas/3.0.19/..., which would 404
 * without this fallback.
 *
 * Resolution prefers the highest release at-or-below the requested version
 * within the SAME major.minor line, falling back to the highest at-or-below
 * release in the same major. Staying at-or-below keeps a frozen 3.0.x doc
 * pointing at 3.0.x schemas rather than jumping forward to a newer minor.
 *
 * When the requested version is stable, prerelease candidates are excluded so
 * a missing stable pin (e.g. /schemas/3.0.0/...) never silently resolves to a
 * release candidate; when the requested version is itself a prerelease, lower
 * prereleases (and stables) on the line are eligible. Returns undefined when
 * nothing in the same major qualifies.
 */
export function resolvePinnedFallback(
  versions: string[],
  requested: string,
): string | undefined {
  const parsed = semver.parse(requested);
  if (!parsed) return undefined;

  const wantStable = parsed.prerelease.length === 0;
  const eligible = (v: string): boolean => {
    const p = semver.parse(v);
    if (!p || p.major !== parsed.major) return false;
    if (wantStable && p.prerelease.length > 0) return false;
    return semver.lte(v, requested);
  };

  const sameMinor = versions
    .filter((v) => eligible(v) && semver.parse(v)!.minor === parsed.minor)
    .sort(semver.rcompare);
  if (sameMinor[0]) return sameMinor[0];

  const sameMajor = versions.filter(eligible).sort(semver.rcompare);
  return sameMajor[0];
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
 * /schemas. Serves the compliance manifest tree (universal, protocols,
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
        published_version?: string;
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
          published_version: versioned[0]?.replace(/\.tgz$/, ""),
          adcp_version: versioned[0]?.replace(/\.tgz$/, ""), // legacy alias through 3.x
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
          docs: "/docs/building/by-layer/L0/schemas#verifying-protocol-bundle-signatures",
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

    // 2. Pinned semver path whose exact version directory is missing: resolve
    //    to the nearest published release on the same line (e.g. a 3.0.19 docs
    //    snapshot's links to /schemas/3.0.19/... resolve to the 3.0.18 schemas
    //    they were built against). Without this, frozen doc snapshots that pin
    //    schema links to a docs-only version bump 404. Tracks whether the
    //    original request was an exact published directory hit so the cache
    //    policy below stays correct.
    let exactPinnedHit = false;
    if (!isAlias && isPinnedVersionPath(originalPath)) {
      const requestedVersion = originalPath.split("/")[1];
      try {
        const versions = await getSchemaVersions();
        const exactVersion = versions.find((version) => version === requestedVersion);
        if (exactVersion) {
          exactPinnedHit = true;
        } else {
          const fallback = resolvePinnedFallback(versions, requestedVersion);
          if (fallback) {
            req.url = "/" + fallback + originalPath.slice(requestedVersion.length + 1);
          }
        }
      } catch {
        // Fall through; static handler below will produce the 404.
      }
    }

    // 3. Set cache-control based on the original request path:
    //    - Exact pinned semver hit (client asked for an immutable version that
    //      exists): 1-year immutable.
    //    - /latest/, aliases (/v2, /v2.5, ...) and resolved pinned fallbacks:
    //      no-cache + ETag, so shared caches revalidate on every request and
    //      pick up retargeting immediately. Without this, edge caches can serve
    //      different versions from different POPs within their TTL window and
    //      cause drift for consumers generating types from the schemas. A
    //      resolved fallback is treated like an alias because what it points at
    //      can change as new patches land on the line.
    if (exactPinnedHit) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, no-cache, must-revalidate");
    }

    // 4. Compatibility fallback: old Trusted Match schema URLs used `/tmp/`.
    // Keep existing released `/tmp/` files authoritative when present, but
    // allow latest/future releases to serve the canonical `/trusted-match/`
    // files without keeping a misleading source directory alive.
    if (mountPath === "/schemas") {
      const currentPath = req.path;
      const legacyPath = legacyTmpPathInfo(currentPath);
      if (legacyPath) {
        const legacyFileExists = await legacyTmpSchemaFileExistsForPath(
          rootPath,
          getSchemaVersions,
          legacyPath,
        );
        if (!legacyFileExists) {
          req.url = legacyPath.trustedMatchPath + req.url.slice(currentPath.length);
        }
      }
    }

    // 5. Redirect bare version directories to their index.json.
    if (matchVersionedDir(req.path)) {
      return res.redirect(mountPath + req.path + "index.json");
    }

    schemasStatic(req, res, next);
  });

  app.get(mountPath + "/", async (_req, res) => {
    try {
      const versions = await getSchemaVersions();
      const latestPerMajor: Record<string, string> = {};
      const latestPerMinor: Record<string, string> = {};

      for (const version of versions) {
        const parsed = semver.parse(version);
        if (!parsed) continue;
        if (parsed.prerelease.length > 0) continue;
        const majorKey = `${parsed.major}`;
        const minorKey = `${parsed.major}.${parsed.minor}`;
        if (!latestPerMajor[majorKey]) latestPerMajor[majorKey] = version;
        if (!latestPerMinor[minorKey]) latestPerMinor[minorKey] = version;
      }

      const aliases: Array<{
        alias: string;
        resolves_to: string;
        path: string;
      }> = [];

      for (const [major, version] of Object.entries(latestPerMajor)) {
        aliases.push({
          alias: `v${major}`,
          resolves_to: version,
          path: `${mountPath}/v${major}/`,
        });
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
        versions: versions.map((v) => versionEntry(v, mountPath)),
        aliases,
        latest_stable: latestStableVersion(versions),
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
