const ALIAS_PATH = /^\/v(\d+)(?:\.(\d+))?(\/.*)?$/;
const VERSION_DIR_PATH = /^\/([^/]+)\/$/;
const SEMVER_PATH = /^\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\/|$)/;
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
const WITHDRAWN_RELEASES = new Set(["3.1.3"]);

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

  // Pinned semver path whose exact version directory is absent from R2: resolve
  // to the nearest published release on the same line (e.g. a 3.0.19 docs
  // snapshot's links to /schemas/3.0.19/... resolve to the 3.0.18 artifacts it
  // was built against). Mirrors the Fly schemas middleware so docs-only version
  // bumps don't 404 when no schema directory is published for them. Tracks
  // whether the exact directory exists so the cache policy below stays correct.
  let exactPinnedHit = false;
  if (!isAlias) {
    const semverMatch = requestPath.match(SEMVER_PATH);
    if (semverMatch) {
      const requestedVersion = semverMatch[1];
      const versions = await getVersions(env.ARTIFACTS, mount);
      if (versions.includes(requestedVersion)) {
        exactPinnedHit = true;
      } else {
        const fallback = resolvePinnedFallback(versions, requestedVersion);
        if (fallback) {
          resolvedPath = `/${fallback}${requestPath.slice(requestedVersion.length + 1)}`;
        }
      }
    }
  }

  const bareVersionMatch = resolvedPath.match(/^\/([^/]+)$/);
  if (bareVersionMatch && (bareVersionMatch[1] === "latest" || parseSemver(bareVersionMatch[1]))) {
    return redirect(`/${mount}${resolvedPath}/`, 301);
  }

  const dirMatch = resolvedPath.match(VERSION_DIR_PATH);
  if (dirMatch && (dirMatch[1] === "latest" || parseSemver(dirMatch[1]))) {
    return redirect(`/${mount}${resolvedPath}index.json`, 302);
  }

  // Only an exact pinned directory hit is immutable. Resolved fallbacks (like
  // aliases) revalidate, since the version they point at can shift as patches
  // land on the line.
  const isImmutableArtifact = exactPinnedHit;
  const cacheControl = isImmutableArtifact
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATE_CACHE_CONTROL;

  const key = `${mount}${resolvedPath}`;
  return r2ArtifactResponse(request, env, key, cacheControl, {
    edgeCache: isImmutableArtifact,
    overrideCacheControl: true,
    fallbackKey: mount === "schemas" ? legacyTmpFallbackKey(key) : undefined,
    ctx,
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

    const sidecarsFor = (tarballName) => ({
      ...(files.has(`${tarballName}.sig`) && { signature: `/protocol/${tarballName}.sig` }),
      ...(files.has(`${tarballName}.crt`) && { certificate: `/protocol/${tarballName}.crt` }),
    });

    const latest = names.includes("latest.tgz")
      ? {
          tarball: "/protocol/latest.tgz",
          checksum: "/protocol/latest.tgz.sha256",
          ...sidecarsFor("latest.tgz"),
          published_version: versioned[0]?.replace(/\.tgz$/, ""),
          adcp_version: versioned[0]?.replace(/\.tgz$/, ""),
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
      versions: versioned.map((name) => ({
        version: name.replace(/\.tgz$/, ""),
        tarball: `/protocol/${name}`,
        checksum: `/protocol/${name}.sha256`,
        ...sidecarsFor(name),
      })),
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
    .filter((segment) => parseSemver(segment))
    .sort((a, b) => compareVersions(b, a));

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
    if (WITHDRAWN_RELEASES.has(version)) return false;
    const parsed = parseSemver(version);
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
 * A stable request excludes prerelease candidates so a missing stable pin never
 * silently resolves to a release candidate; a prerelease request also accepts
 * lower prereleases (and stables) on the line. Returns undefined when nothing in
 * the same major qualifies.
 */
export function resolvePinnedFallback(versions, requested) {
  const parsed = parseSemver(requested);
  if (!parsed) return undefined;

  const wantStable = parsed.prerelease.length === 0;
  const eligible = (candidate) => {
    if (WITHDRAWN_RELEASES.has(candidate)) return false;
    const p = parseSemver(candidate);
    if (!p || p.major !== parsed.major) return false;
    if (wantStable && p.prerelease.length > 0) return false;
    return compareVersions(candidate, requested) <= 0;
  };

  const sameMinor = versions
    .filter((candidate) => eligible(candidate) && parseSemver(candidate).minor === parsed.minor)
    .sort((a, b) => compareVersions(b, a));
  if (sameMinor[0]) return sameMinor[0];

  const sameMajor = versions.filter(eligible).sort((a, b) => compareVersions(b, a));
  return sameMajor[0];
}

export function clearVersionCacheForTests() {
  versionCache.clear();
}

function buildAliases(versions, mount) {
  const latestPerMajor = {};
  const latestPerMinor = {};

  for (const version of versions) {
    if (WITHDRAWN_RELEASES.has(version)) continue;
    const parsed = parseSemver(version);
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
  const withdrawn = WITHDRAWN_RELEASES.has(version);
  const parsed = parseSemver(version);
  const prerelease = !!parsed && parsed.prerelease.length > 0;
  const label = prerelease ? String(parsed.prerelease[0]).toLowerCase() : "";
  const stableVersion = prerelease ? version.split("-")[0] : undefined;
  const supersededBy = stableVersion && knownVersions.includes(stableVersion) ? stableVersion : undefined;
  return {
    version,
    stability: withdrawn
      ? "withdrawn"
      : prerelease
        ? (label === "rc" || label === "beta" ? label : "prerelease")
        : "stable",
    prerelease,
    deprecated: withdrawn || Boolean(supersededBy),
    ...(withdrawn ? { withdrawn: true } : {}),
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    path: `${mountPath}/${version}/`,
  };
}

function latestStableVersion(versions) {
  return versions.find((version) => {
    if (WITHDRAWN_RELEASES.has(version)) return false;
    const parsed = parseSemver(version);
    return parsed && parsed.prerelease.length === 0;
  }) || null;
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

function redirect(location, status) {
  return new Response(null, { status, headers: corsHeaders({ Location: location }) });
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
