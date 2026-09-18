const ALIAS_PATH = /^\/v(\d+)(?:\.(\d+))?(\/.*)?$/;
const VERSION_DIR_PATH = /^\/([^/]+)\/$/;
const PINNED_TARBALL = /(?:^|\/)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/;
const PINNED_TARBALL_SIDECAR = /(?:^|\/)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz\.(?:sha256|sig|crt)$/;
const LEGACY_TMP_SCHEMA_KEY = /^schemas\/(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/tmp\/([A-Za-z0-9._-]+\.json)$/;
const TRUSTED_MATCH_SCHEMA_FILES = new Set([
  "available-package.json",
  "context-match-request.json",
  "context-match-response.json",
  "error.json",
  "identity-match-request.json",
  "identity-match-response.json",
  "offer-price.json",
  "offer.json",
  "provider-registration.json",
]);

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "public, no-cache, must-revalidate";
const VERSION_CACHE_TTL_MS = 60 * 1000;
const versionCache = new Map();
const RELEASE_STATUS_OVERRIDES = new Map([
  ["3.1.3", "withdrawn"],
  ["3.2.0", "unpublished"],
]);

function isSelectableRelease(version) {
  return !RELEASE_STATUS_OVERRIDES.has(version);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders({ Allow: "GET, HEAD" }),
    });
  }

  if (pathname === "/schemas" || pathname === "/compliance") {
    return redirect(`${pathname}/`, 301);
  }

  if (pathname === "/protocol" || pathname === "/protocol/") {
    return protocolDiscoveryResponse(env.ARTIFACTS);
  }

  if (pathname === "/schemas/" || pathname === "/compliance/") {
    const mount = pathname.slice(1, -1);
    return discoveryResponse(env.ARTIFACTS, mount);
  }

  if (pathname.startsWith("/schemas/")) {
    return versionedArtifactResponse(request, env, ctx, "schemas", pathname);
  }

  if (pathname.startsWith("/compliance/")) {
    return versionedArtifactResponse(request, env, ctx, "compliance", pathname);
  }

  if (pathname.startsWith("/protocol/")) {
    const key = pathname.slice(1);
    const cachePolicy = cachePolicyForProtocolPath(pathname);
    return r2ArtifactResponse(request, env, key, cachePolicy.cacheControl, {
      edgeCache: cachePolicy.edgeCache,
      overrideCacheControl: true,
      ctx,
    });
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders() });
}

async function versionedArtifactResponse(request, env, ctx, mount, pathname) {
  const mountPrefix = `/${mount}`;
  const requestPath = pathname.slice(mountPrefix.length);
  const aliasMatch = requestPath.match(ALIAS_PATH);
  let resolvedPath = requestPath;
  let isAlias = false;

  if (aliasMatch) {
    isAlias = true;
    const requestedMajor = Number.parseInt(aliasMatch[1], 10);
    const requestedMinor = aliasMatch[2] === undefined ? undefined : Number.parseInt(aliasMatch[2], 10);
    const rest = aliasMatch[3] || "/";

    if (requestedMajor === 1 && requestedMinor === undefined) {
      resolvedPath = `/latest${rest}`;
    } else {
      const versions = await getVersions(env.ARTIFACTS, mount);
      const targetVersion = findMatchingVersion(versions, requestedMajor, requestedMinor);
      if (targetVersion) {
        resolvedPath = `/${targetVersion}${rest}`;
      }
    }
  }

  // Only stable schema pins have a docs-gap fallback contract. Prereleases
  // and compliance pins require an exact published version, before any
  // directory redirect, cache lookup, or origin fallback can run.
  let exactPinnedHit = false;
  let requiresExactVersion = false;
  if (!isAlias) {
    const requestedVersion = requestPath.split("/")[1];
    const parsed = parseArtifactVersion(requestedVersion);
    if (parsed) {
      requiresExactVersion = mount === "compliance" || parsed.prerelease.length > 0;
      let versions;
      try {
        versions = await getVersions(env.ARTIFACTS, mount);
      } catch (error) {
        if (requiresExactVersion) return artifactNotFound(request);
        throw error;
      }
      if (versions.includes(requestedVersion)) {
        exactPinnedHit = true;
      } else {
        if (requiresExactVersion) return artifactNotFound(request);
        const fallback = resolvePinnedFallback(versions, requestedVersion);
        if (fallback) {
          resolvedPath = `/${fallback}${requestPath.slice(requestedVersion.length + 1)}`;
        }
      }
    }
  }

  // Redirects follow the same cache policy as files in the Fly middleware.
  const cacheControl = exactPinnedHit ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
  const bareVersionMatch = resolvedPath.match(/^\/([^/]+)$/);
  if (bareVersionMatch && (bareVersionMatch[1] === "latest" || parseArtifactVersion(bareVersionMatch[1]))) {
    return redirect(`/${mount}${resolvedPath}/`, 301, { "cache-control": cacheControl });
  }

  const dirMatch = resolvedPath.match(VERSION_DIR_PATH);
  if (dirMatch && (dirMatch[1] === "latest" || parseArtifactVersion(dirMatch[1]))) {
    return redirect(`/${mount}${resolvedPath}index.json`, 302, { "cache-control": cacheControl });
  }

  // Only an exact pinned directory hit is immutable. Resolved fallbacks (like
  // aliases) revalidate, since the version they point at can shift as patches
  // land on the line.
  const isImmutableArtifact = exactPinnedHit;

  const key = `${mount}${resolvedPath}`;
  return r2ArtifactResponse(request, env, key, cacheControl, {
    edgeCache: isImmutableArtifact,
    overrideCacheControl: true,
    requiresExactVersion,
    fallbackKey: mount === "schemas" ? legacyTmpFallbackKey(key) : undefined,
    ctx,
  });
}

function artifactNotFound(request) {
  return new Response(request.method === "HEAD" ? null : "Not Found", {
    status: 404,
    headers: corsHeaders({ "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" }),
  });
}

async function discoveryResponse(bucket, mount) {
  try {
    const versions = await getVersions(bucket, mount);
    const aliases = buildAliases(versions, mount);
    return jsonResponse({
      versions: versions.map((version) => versionEntry(version, `/${mount}`, versions)),
      aliases,
      latest_stable: latestStableVersion(versions),
      latest: {
        path: `/${mount}/latest/`,
        note: "Development version, may differ from released versions",
      },
    });
  } catch (error) {
    return jsonResponse({ error: "Failed to list versions" }, 500);
  }
}

async function protocolDiscoveryResponse(bucket) {
  try {
    const entries = await listObjects(bucket, "protocol/");
    const names = entries
      .map((entry) => entry.key.slice("protocol/".length))
      .filter((name) => name.endsWith(".tgz") && (name === "latest.tgz" || parseSemver(name.replace(/\.tgz$/, ""))));
    const files = new Set(entries.map((entry) => entry.key.slice("protocol/".length)));
    const versioned = names
      .filter((name) => name !== "latest.tgz")
      .sort((a, b) => compareVersions(b.replace(/\.tgz$/, ""), a.replace(/\.tgz$/, "")));
    const selectableVersioned = versioned.filter((name) =>
      isSelectableRelease(name.replace(/\.tgz$/, "")),
    );

    const sidecarsFor = (tarballName) => ({
      ...(files.has(`${tarballName}.sig`) && { signature: `/protocol/${tarballName}.sig` }),
      ...(files.has(`${tarballName}.crt`) && { certificate: `/protocol/${tarballName}.crt` }),
    });

    const latest = names.includes("latest.tgz")
      ? {
          tarball: "/protocol/latest.tgz",
          checksum: "/protocol/latest.tgz.sha256",
          ...sidecarsFor("latest.tgz"),
          published_version: selectableVersioned[0]?.replace(/\.tgz$/, ""),
          adcp_version: selectableVersioned[0]?.replace(/\.tgz$/, ""),
          note: "Development bundle — changes with every merge. Pin a version for production.",
        }
      : null;

    return jsonResponse({
      generated_at: new Date().toISOString(),
      signature_verification: {
        tool: "cosign verify-blob",
        certificate_identity_regexp:
          "^https://github\\.com/adcontextprotocol/adcp/\\.github/workflows/release\\.yml@refs/heads/.*$",
        certificate_oidc_issuer: "https://token.actions.githubusercontent.com",
        docs: "/docs/building/by-layer/L0/schemas#verifying-protocol-bundle-signatures",
      },
      versions: versioned.map((name) => {
        const version = name.replace(/\.tgz$/, "");
        return {
          version,
          ...releaseStatusMetadata(version),
          tarball: `/protocol/${name}`,
          checksum: `/protocol/${name}.sha256`,
          ...sidecarsFor(name),
        };
      }),
      latest,
    });
  } catch (error) {
    return jsonResponse({ error: "Failed to list protocol tarballs" }, 500);
  }
}

async function r2ArtifactResponse(request, env, key, fallbackCacheControl, options = {}) {
  const cache = options.edgeCache && request.method === "GET" ? getEdgeCache() : null;
  const cacheKey = cache ? edgeCacheKey(request) : null;
  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let object = request.method === "HEAD"
    ? await env.ARTIFACTS.head(key)
    : await env.ARTIFACTS.get(key);
  if (!object && options.fallbackKey) {
    object = request.method === "HEAD"
      ? await env.ARTIFACTS.head(options.fallbackKey)
      : await env.ARTIFACTS.get(options.fallbackKey);
  }

  if (!object) {
    if (options.requiresExactVersion) return artifactNotFound(request);
    return fallbackResponse(request, env);
  }

  const headers = corsHeaders();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  headers.set("etag", object.httpEtag ?? object.etag ?? "");
  if (object.uploaded) {
    headers.set("last-modified", new Date(object.uploaded).toUTCString());
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", contentTypeForKey(key));
  }
  if (options.overrideCacheControl || !headers.has("cache-control")) {
    headers.set("cache-control", fallbackCacheControl);
  }

  const response = new Response(request.method === "HEAD" ? null : object.body, { headers });
  if (cache && cacheKey) {
    const put = cache.put(cacheKey, response.clone()).catch(() => undefined);
    if (typeof options.ctx?.waitUntil === "function") {
      options.ctx.waitUntil(put);
    } else {
      await put;
    }
  }

  return response;
}

async function fallbackResponse(request, env) {
  if (!env.FALLBACK_ORIGIN) {
    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  }
  const fallbackUrl = new URL(request.url);
  const origin = new URL(env.FALLBACK_ORIGIN);
  fallbackUrl.protocol = origin.protocol;
  fallbackUrl.host = origin.host;
  const response = await fetch(new Request(fallbackUrl, request));
  const headers = corsHeaders(response.headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function getVersions(bucket, mount) {
  const cacheKey = mount;
  const now = Date.now();
  const cached = versionCache.get(cacheKey);
  if (cached && now - cached.timestamp < VERSION_CACHE_TTL_MS) {
    return cached.versions;
  }

  const prefix = `${mount}/`;
  const prefixes = await listPrefixes(bucket, prefix);
  const versions = prefixes
    .map((entry) => entry.slice(prefix.length).replace(/\/$/, ""))
    .filter((segment) => parseArtifactVersion(segment))
    .sort((a, b) => compareArtifactVersions(b, a));

  versionCache.set(cacheKey, { versions, timestamp: now });
  return versions;
}

async function listPrefixes(bucket, prefix) {
  const prefixes = [];
  const seen = new Set();
  let cursor;
  do {
    const listed = await bucket.list({ prefix, delimiter: "/", cursor });
    for (const entry of listed.delimitedPrefixes ?? []) {
      if (!seen.has(entry)) {
        seen.add(entry);
        prefixes.push(entry);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return prefixes;
}

async function listObjects(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const listed = await bucket.list({ prefix, cursor });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}

export function findMatchingVersion(versions, requestedMajor, requestedMinor) {
  return versions.find((version) => {
    if (!isSelectableRelease(version)) return false;
    const parsed = parseArtifactVersion(version);
    if (!parsed || parsed.major !== requestedMajor) return false;
    if (parsed.prerelease.length > 0) return false;
    return requestedMinor === undefined || parsed.minor === requestedMinor;
  });
}

/**
 * Resolve a pinned semver whose exact version directory is not published to the
 * nearest release it should map to: the highest release at-or-below the request
 * on the same major.minor line, falling back to the highest at-or-below release
 * in the same major. Staying at-or-below keeps a frozen 3.0.x doc pointing at
 * 3.0.x artifacts rather than jumping forward to a newer minor.
 *
 * Only stable schema docs pins may fall back, and only to stable candidates.
 * Prerelease requests always require their exact published version.
 */
export function resolvePinnedFallback(versions, requested) {
  const parsed = parseArtifactVersion(requested);
  if (!parsed || parsed.prerelease.length > 0) return undefined;

  const eligible = (candidate) => {
    if (!isSelectableRelease(candidate)) return false;
    const p = parseArtifactVersion(candidate);
    if (!p || p.major !== parsed.major) return false;
    if (p.prerelease.length > 0) return false;
    return compareArtifactVersions(candidate, requested) <= 0;
  };

  const sameMinor = versions
    .filter((candidate) => eligible(candidate) && parseArtifactVersion(candidate).minor === parsed.minor)
    .sort((a, b) => compareArtifactVersions(b, a));
  if (sameMinor[0]) return sameMinor[0];

  const sameMajor = versions.filter(eligible).sort((a, b) => compareArtifactVersions(b, a));
  return sameMajor[0];
}

export function clearVersionCacheForTests() {
  versionCache.clear();
}

function buildAliases(versions, mount) {
  const latestPerMajor = {};
  const latestPerMinor = {};

  for (const version of versions) {
    if (!isSelectableRelease(version)) continue;
    const parsed = parseArtifactVersion(version);
    if (!parsed) continue;
    if (parsed.prerelease.length > 0) continue;
    const majorKey = `${parsed.major}`;
    const minorKey = `${parsed.major}.${parsed.minor}`;
    if (!latestPerMajor[majorKey]) latestPerMajor[majorKey] = version;
    if (!latestPerMinor[minorKey]) latestPerMinor[minorKey] = version;
  }

  const aliases = [];
  for (const [major, version] of Object.entries(latestPerMajor)) {
    aliases.push({
      alias: `v${major}`,
      resolves_to: version,
      path: `/${mount}/v${major}/`,
    });
  }

  for (const [minorKey, version] of Object.entries(latestPerMinor)) {
    aliases.push({
      alias: `v${minorKey}`,
      resolves_to: version,
      path: `/${mount}/v${minorKey}/`,
    });
  }

  return aliases.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { numeric: true }));
}

function versionEntry(version, mountPath, knownVersions = []) {
  const statusMetadata = releaseStatusMetadata(version);
  const parsed = parseArtifactVersion(version);
  const prerelease = !!parsed && parsed.prerelease.length > 0;
  const label = prerelease ? String(parsed.prerelease[0]).toLowerCase() : "";
  const stableVersion = prerelease ? version.split("-")[0] : undefined;
  const supersededBy = stableVersion && knownVersions.includes(stableVersion) ? stableVersion : undefined;
  return {
    version,
    stability: statusMetadata.stability
      ?? (prerelease
        ? (label === "rc" || label === "beta" ? label : "prerelease")
        : "stable"),
    prerelease,
    deprecated: statusMetadata.deprecated ?? Boolean(supersededBy),
    ...statusMetadata,
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    path: `${mountPath}/${version}/`,
  };
}

function latestStableVersion(versions) {
  return versions.find((version) => {
    if (!isSelectableRelease(version)) return false;
    const parsed = parseArtifactVersion(version);
    return parsed && parsed.prerelease.length === 0;
  }) || null;
}

function releaseStatusMetadata(version) {
  const status = RELEASE_STATUS_OVERRIDES.get(version);
  if (status === "withdrawn") {
    return { stability: "withdrawn", deprecated: true, withdrawn: true };
  }
  if (status === "unpublished") {
    return { stability: "unpublished", deprecated: false, published: false };
  }
  if (version.startsWith("2.")) {
    return { deprecated: true };
  }
  return {};
}

// Schema/compliance pins preserve the full prefix, including build metadata.
// Keep protocol parsing unchanged: its exact tarball routes have no fallback.
function parseArtifactVersion(version) {
  if (version.length > 256) return null;
  // Fly's semver parser also accepts a leading v; keep the raw prefix for lookup.
  const [core, build, ...extra] = (version.startsWith("v") ? version.slice(1) : version).split("+");
  if (extra.length || (build !== undefined && !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(build))) return null;
  const parsed = parseSemver(core);
  if (!parsed) return null;
  const numbers = core.split("-")[0].split(".");
  if (numbers.some((part) => /^0\d/.test(part) || !Number.isSafeInteger(Number(part)))) return null;
  if (parsed.prerelease.some((part) => !part || (/^\d+$/.test(part) && /^0\d/.test(part)))) return null;
  return parsed;
}

function compareArtifactVersions(left, right) {
  return compareVersions(left.replace(/^v/, "").split("+")[0], right.replace(/^v/, "").split("+")[0]);
}

function parseSemver(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const aNum = /^\d+$/.test(a.prerelease[i]);
    const bNum = /^\d+$/.test(b.prerelease[i]);
    if (aNum && bNum) {
      const diff = Number.parseInt(a.prerelease[i], 10) - Number.parseInt(b.prerelease[i], 10);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (a.prerelease[i] !== b.prerelease[i]) {
      return a.prerelease[i] > b.prerelease[i] ? 1 : -1;
    }
  }
  return 0;
}

function cachePolicyForProtocolPath(pathname) {
  if (PINNED_TARBALL.test(pathname)) {
    return { cacheControl: IMMUTABLE_CACHE_CONTROL, edgeCache: true };
  }
  if (PINNED_TARBALL_SIDECAR.test(pathname)) {
    return { cacheControl: REVALIDATE_CACHE_CONTROL, edgeCache: false };
  }
  return { cacheControl: REVALIDATE_CACHE_CONTROL, edgeCache: false };
}

function getEdgeCache() {
  return typeof caches !== "undefined" ? caches.default : null;
}

function edgeCacheKey(request) {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

function legacyTmpFallbackKey(key) {
  const match = key.match(LEGACY_TMP_SCHEMA_KEY);
  if (!match) return undefined;
  const [, version, filename] = match;
  if (!TRUSTED_MATCH_SCHEMA_FILES.has(filename)) return undefined;
  return `schemas/${version}/trusted-match/${filename}`;
}

function contentTypeForKey(key) {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".yaml") || key.endsWith(".yml")) return "application/yaml; charset=utf-8";
  if (key.endsWith(".md") || key.endsWith(".mdx")) return "text/markdown; charset=utf-8";
  if (key.endsWith(".txt") || key.endsWith(".sha256")) return "text/plain; charset=utf-8";
  if (key.endsWith(".tgz")) return "application/gzip";
  if (key.endsWith(".sig")) return "application/octet-stream";
  if (key.endsWith(".crt")) return "application/x-pem-file";
  return "application/octet-stream";
}

function normalizePath(pathname) {
  return pathname.replace(/\/{2,}/g, "/");
}

function redirect(location, status, headers = {}) {
  return new Response(null, { status, headers: corsHeaders({ ...headers, Location: location }) });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": REVALIDATE_CACHE_CONTROL,
    }),
  });
}

function corsHeaders(init) {
  const headers = new Headers(init);
  headers.set("access-control-allow-origin", "*");
  return headers;
}
