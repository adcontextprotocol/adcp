const ALIAS_PATH = /^\/v(\d+)(?:\.(\d+))?(\/.*)?$/;
const VERSION_DIR_PATH = /^\/([^/]+)\/$/;
const SEMVER_PATH = /^\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\/|$)/;
const PINNED_TARBALL = /(?:^|\/)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz(?:\.sha256|\.sig|\.crt)?$/;

const VERSION_CACHE_TTL_MS = 60 * 1000;
const versionCache = new Map();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env, _ctx) {
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
    return versionedArtifactResponse(request, env, "schemas", pathname);
  }

  if (pathname.startsWith("/compliance/")) {
    return versionedArtifactResponse(request, env, "compliance", pathname);
  }

  if (pathname.startsWith("/protocol/")) {
    const key = pathname.slice(1);
    return r2ArtifactResponse(request, env, key, cacheControlForProtocolPath(pathname));
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders() });
}

async function versionedArtifactResponse(request, env, mount, pathname) {
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

  const bareVersionMatch = resolvedPath.match(/^\/([^/]+)$/);
  if (bareVersionMatch && (bareVersionMatch[1] === "latest" || parseSemver(bareVersionMatch[1]))) {
    return redirect(`/${mount}${resolvedPath}/`, 301);
  }

  const dirMatch = resolvedPath.match(VERSION_DIR_PATH);
  if (dirMatch && (dirMatch[1] === "latest" || parseSemver(dirMatch[1]))) {
    return redirect(`/${mount}${resolvedPath}index.json`, 302);
  }

  const cacheControl = !isAlias && SEMVER_PATH.test(requestPath)
    ? "public, max-age=31536000, immutable"
    : "public, no-cache, must-revalidate";

  return r2ArtifactResponse(request, env, `${mount}${resolvedPath}`, cacheControl);
}

async function discoveryResponse(bucket, mount) {
  try {
    const versions = await getVersions(bucket, mount);
    const aliases = buildAliases(versions, mount);
    return jsonResponse({
      versions: versions.map((version) => ({ version, path: `/${mount}/${version}/` })),
      aliases,
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

async function r2ArtifactResponse(request, env, key, fallbackCacheControl) {
  const object = request.method === "HEAD"
    ? await env.ARTIFACTS.head(key)
    : await env.ARTIFACTS.get(key);

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
  if (!headers.has("cache-control")) {
    headers.set("cache-control", fallbackCacheControl);
  }

  return new Response(request.method === "HEAD" ? null : object.body, { headers });
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
    const parsed = parseSemver(version);
    if (!parsed || parsed.major !== requestedMajor) return false;
    return requestedMinor === undefined || parsed.minor === requestedMinor;
  });
}

export function clearVersionCacheForTests() {
  versionCache.clear();
}

function buildAliases(versions, mount) {
  const latestPerMinor = {};
  let latestMajorVersion;

  for (const version of versions) {
    const parsed = parseSemver(version);
    if (!parsed) continue;
    const minorKey = `${parsed.major}.${parsed.minor}`;
    if (!latestMajorVersion) latestMajorVersion = version;
    if (!latestPerMinor[minorKey]) latestPerMinor[minorKey] = version;
  }

  const aliases = [];
  if (latestMajorVersion) {
    const major = parseSemver(latestMajorVersion).major;
    aliases.push({
      alias: `v${major}`,
      resolves_to: latestMajorVersion,
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

function cacheControlForProtocolPath(pathname) {
  return PINNED_TARBALL.test(pathname)
    ? "public, max-age=31536000, immutable"
    : "public, no-cache, must-revalidate";
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
      "cache-control": "public, no-cache, must-revalidate",
    }),
  });
}

function corsHeaders(init) {
  const headers = new Headers(init);
  headers.set("access-control-allow-origin", "*");
  return headers;
}
