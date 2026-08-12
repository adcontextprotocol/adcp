import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { globSync } from 'glob';

const LINK_HOSTS = new Set(['agenticadvertising.org', 'docs.adcontextprotocol.org']);
const SKIPPED_PATH_PREFIXES = ['/api/'];
const ROOT = process.cwd();
const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 8;
const MANUAL_RETRIES = 2;
const MAX_STABLE_DOC_REDIRECTS = 8;
const URLS_RULES_FILE = 'server/src/addie/rules/urls.md';

export const URL_CLASS = Object.freeze({
  DIRECT: 'direct',
  ACTION: 'action',
  STABLE_DOCS: 'stable-docs',
});

const CATALOG_SECTIONS = new Map([
  ['Direct destinations — no redirects', URL_CLASS.DIRECT],
  ['Action entry points — redirects expected', URL_CLASS.ACTION],
  ['Stable documentation aliases — keep unversioned', URL_CLASS.STABLE_DOCS],
]);

const EXCLUDED_CATALOG_SECTIONS = [
  /^Common hallucinations(?:\s|\u2014|\u2013|-|$)/i,
  /^Deprecated(?:\s|\u2014|\u2013|-|$)/i,
];

export class CatalogParseError extends Error {
  constructor(diagnostics) {
    super(`Invalid URL catalog:\n${diagnostics.map((diagnostic) => `- ${diagnostic}`).join('\n')}`);
    this.name = 'CatalogParseError';
    this.diagnostics = diagnostics;
  }
}

export function getCandidateFiles(root = ROOT) {
  return globSync(
    [
      'docs/**/*.{md,mdx}',
      'dist/docs/**/*.{md,mdx}',
      'README.md',
      'server/src/addie/rules/*.md',
      'server/src/addie/**/*.ts',
    ],
    { cwd: root, nodir: true },
  );
}

function normalizeExtractedUrl(url) {
  return url.replace(/[.,;:!?]+$/, '');
}

function isOwnedUrl(url) {
  try {
    return LINK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// General source files are scanned liberally because an owned URL in prose is
// still a link we maintain. urls.md is parsed separately as a structured
// catalog so prose examples, hallucinations, and audit entries are not treated
// as live catalog entries.
export function extractUrlsFromText(text) {
  const matches = text.match(/https?:\/\/[^\s)"'>`\\|\]]+/g) ?? [];

  return [...new Set(matches)]
    .map(normalizeExtractedUrl)
    .filter((url) => !url.includes('${'))
    .filter((url) => !url.includes('{') && !url.includes('}'))
    .filter(isOwnedUrl);
}

export function parseUrlCatalog(markdown) {
  const entries = [];
  const diagnostics = [];
  const sectionCounts = new Map(
    [...CATALOG_SECTIONS.keys()].map((heading) => [heading, 0]),
  );
  let classification = null;
  let headingName = null;
  let excludedSection = false;

  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      headingName = heading[1];
      classification = CATALOG_SECTIONS.get(headingName) ?? null;
      excludedSection = EXCLUDED_CATALOG_SECTIONS.some((pattern) => pattern.test(headingName));
      if (classification) {
        sectionCounts.set(headingName, sectionCounts.get(headingName) + 1);
      }
      continue;
    }

    const listEntry = /^\s*-\s+(https?:\/\/[^\s)"'>`\\|\]]+)/.exec(line);
    if (!listEntry) continue;

    const url = normalizeExtractedUrl(listEntry[1]);
    if (url.includes('{') || url.includes('}') || !isOwnedUrl(url)) continue;

    if (classification) {
      entries.push({ url, classification, line: index + 1 });
    } else if (!excludedSection) {
      diagnostics.push(
        `line ${index + 1}: owned URL list entry ${url} is under unrecognized live section ${JSON.stringify(headingName ?? '(before first H2)')}`,
      );
    }
  }

  for (const [heading, count] of sectionCounts) {
    if (count === 0) {
      diagnostics.push(`missing required section "## ${heading}"`);
    } else if (count > 1) {
      diagnostics.push(`required section "## ${heading}" appears ${count} times`);
    }
  }

  if (diagnostics.length > 0) throw new CatalogParseError(diagnostics);
  return entries;
}

export function extractUrls(file, root = ROOT) {
  const text = readFileSync(join(root, file), 'utf8');
  return file === URLS_RULES_FILE
    ? parseUrlCatalog(text).map(({ url }) => url)
    : extractUrlsFromText(text);
}

export function shouldCheck(url) {
  const parsed = new URL(url);
  return !SKIPPED_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
}

export function resolvesToLocalDocsSource(url, root = ROOT) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'docs.adcontextprotocol.org') return false;

  let relativePath;
  try {
    relativePath = decodeURIComponent(parsed.pathname)
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  } catch {
    return false;
  }
  if (relativePath === '' || relativePath === 'docs') {
    relativePath = 'docs/intro';
  }
  if (relativePath.split('/').includes('..')) return false;

  return [
    `${relativePath}.md`,
    `${relativePath}.mdx`,
    `${relativePath}/index.md`,
    `${relativePath}/index.mdx`,
  ].some((candidate) => existsSync(join(root, candidate)));
}

export async function fetchStatus(
  url,
  method,
  retries = 3,
  {
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: 'follow',
        headers: {
          'User-Agent': 'adcp-owned-link-check/1.0',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status >= 500 && attempt < retries) {
        await cancelBody(response);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      await cancelBody(response);
      return response.status;
    } catch (error) {
      if (attempt < retries) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`fetchStatus exhausted retries without returning for ${url}`);
}

// 405 means the endpoint exists but rejects this HTTP method (e.g. MCP
// Streamable-HTTP endpoints reject GET). Treat as reachable.
export function isReachableStatus(status) {
  return status < 400 || status === 405;
}

export async function checkUrl(
  url,
  {
    fetchImpl = globalThis.fetch,
    root = ROOT,
    sleep,
    allowLocalSource = true,
  } = {},
) {
  // Current-source docs are deployed after merge, so ordinary docs references
  // may resolve locally. Catalog entries opt out: every live catalog entry must
  // also prove that its public URL is reachable with redirects followed.
  if (allowLocalSource && resolvesToLocalDocsSource(url, root)) {
    return { ok: true, method: 'LOCAL_SOURCE' };
  }

  try {
    const fetchOptions = { fetchImpl };
    if (sleep) fetchOptions.sleep = sleep;

    const headStatus = await fetchStatus(url, 'HEAD', 3, fetchOptions);
    if (isReachableStatus(headStatus)) {
      return { ok: true, status: headStatus, method: 'HEAD' };
    }

    const getStatus = await fetchStatus(url, 'GET', 3, fetchOptions);
    return { ok: isReachableStatus(getStatus), status: getStatus, method: 'GET' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Status and headers are sufficient for link checks. A cancellation error
    // must not hide the actual redirect or reachability result.
  }
}

export async function fetchManualGet(
  url,
  retries = MANUAL_RETRIES,
  {
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'adcp-owned-link-check/1.0',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const result = {
        status: response.status,
        location: response.headers.get('location'),
      };
      await cancelBody(response);

      if (response.status >= 500 && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return result;
    } catch (error) {
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`fetchManualGet exhausted retries without returning for ${url}`);
}

function resolveLocation(
  sourceUrl,
  location,
  status,
  prefix,
  { inheritFragmentFrom } = {},
) {
  if (!location) {
    return {
      ok: false,
      error: `${prefix}: ${sourceUrl} → [missing Location header on HTTP ${status}]`,
    };
  }

  try {
    const resolved = new URL(location, sourceUrl);
    if (!location.includes('#') && inheritFragmentFrom) {
      resolved.hash = new URL(inheritFragmentFrom).hash;
    }
    return { ok: true, url: resolved.href };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `${prefix}: ${sourceUrl} → [malformed Location ${JSON.stringify(location)}: ${detail}]`,
    };
  }
}

function manualCheckOptions({ fetchImpl, sleep, retries }) {
  const options = { fetchImpl };
  if (sleep) options.sleep = sleep;
  return { retries: retries ?? MANUAL_RETRIES, options };
}

export async function checkDirectUrl(
  url,
  { fetchImpl = globalThis.fetch, sleep, retries } = {},
) {
  let response;
  try {
    const request = manualCheckOptions({ fetchImpl, sleep, retries });
    response = await fetchManualGet(url, request.retries, request.options);
  } catch (error) {
    return {
      ok: false,
      error: `Direct destination check failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status, method: 'GET' };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = resolveLocation(url, response.location, response.status, 'REDIRECT DRIFT');
    if (!location.ok) {
      return {
        ok: false,
        status: response.status,
        error: `${location.error} (expected no redirect)`,
      };
    }
    return {
      ok: false,
      status: response.status,
      location: location.url,
      error: `REDIRECT DRIFT: ${url} → ${location.url} (expected no redirect)`,
    };
  }

  return {
    ok: false,
    status: response.status,
    error: `Direct destination check failed for ${url}: GET ${response.status} (expected 2xx)`,
  };
}

// Backward-compatible name for the original pure test seam.
export const checkCanonicalUrl = checkDirectUrl;

export function normalizeLogicalDocsPath(pathname) {
  return pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/index$/, '');
}

export function isAdcpReleaseSegment(segment) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/.test(segment);
}

export function isEquivalentStableDocsRedirect(sourceUrl, targetUrl) {
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  if (source.hostname !== 'docs.adcontextprotocol.org') return false;
  if (source.origin !== target.origin) return false;
  if (!source.pathname.startsWith('/docs/')) return false;
  if (source.hash !== target.hash) return false;

  const snapshot = /^\/dist\/docs\/([^/]+)\/(.+)$/.exec(target.pathname);
  if (!snapshot || !isAdcpReleaseSegment(snapshot[1])) return false;

  const sourcePath = normalizeLogicalDocsPath(source.pathname.slice('/docs/'.length));
  const targetPath = normalizeLogicalDocsPath(snapshot[2]);
  return sourcePath !== '' && sourcePath === targetPath;
}

export async function checkStableDocsAlias(
  url,
  {
    fetchImpl = globalThis.fetch,
    sleep,
    retries,
    maxRedirects = MAX_STABLE_DOC_REDIRECTS,
  } = {},
) {
  const request = manualCheckOptions({ fetchImpl, sleep, retries });
  const visited = new Set([new URL(url).href]);
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    let response;
    try {
      response = await fetchManualGet(currentUrl, request.retries, request.options);
    } catch (error) {
      return {
        ok: false,
        error: `Stable documentation alias check failed for ${currentUrl}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        ok: true,
        status: response.status,
        method: 'GET',
        ...(redirectCount > 0 ? { location: currentUrl, redirects: redirectCount } : {}),
      };
    }

    if (response.status < 300 || response.status >= 400) {
      return {
        ok: false,
        status: response.status,
        error: `Stable documentation alias check failed for ${currentUrl}: GET ${response.status} (expected 2xx or an equivalent snapshot redirect)`,
      };
    }

    if (redirectCount >= maxRedirects) {
      return {
        ok: false,
        status: response.status,
        error: `STABLE DOC ALIAS REDIRECT LIMIT: ${url} exceeded ${maxRedirects} redirects at ${currentUrl}`,
      };
    }

    const location = resolveLocation(
      currentUrl,
      response.location,
      response.status,
      'STABLE DOC ALIAS DRIFT',
      { inheritFragmentFrom: url },
    );
    if (!location.ok) {
      return { ok: false, status: response.status, error: location.error };
    }
    if (!isEquivalentStableDocsRedirect(url, location.url)) {
      return {
        ok: false,
        status: response.status,
        location: location.url,
        error: `STABLE DOC ALIAS DRIFT: ${url} → ${location.url} (expected the same logical path under /dist/docs/<release>)`,
      };
    }
    if (visited.has(location.url)) {
      return {
        ok: false,
        status: response.status,
        location: location.url,
        error: `STABLE DOC ALIAS LOOP: ${url} revisited ${location.url}`,
      };
    }

    visited.add(location.url);
    currentUrl = location.url;
    redirectCount += 1;
  }
}

export async function mapWithConcurrency(items, task, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

export async function main({
  root = ROOT,
  fetchImpl = globalThis.fetch,
  sleep,
  output = console,
} = {}) {
  const catalogPath = join(root, URLS_RULES_FILE);
  if (!existsSync(catalogPath)) {
    output.error(`Invalid URL catalog: missing ${URLS_RULES_FILE}`);
    return false;
  }

  let catalog;
  try {
    catalog = parseUrlCatalog(readFileSync(catalogPath, 'utf8'))
      .filter(({ url }) => shouldCheck(url));
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return false;
  }

  const urlSources = new Map();

  for (const file of getCandidateFiles(root)) {
    const fileUrls = file === URLS_RULES_FILE
      ? catalog.map(({ url }) => url)
      : extractUrls(file, root);
    for (const url of fileUrls) {
      if (!shouldCheck(url)) continue;
      const existing = urlSources.get(url) ?? [];
      existing.push(file);
      urlSources.set(url, existing);
    }
  }

  const catalogUrls = new Set(catalog.map(({ url }) => url));
  const urls = [...urlSources.keys()].sort();

  // One shared pool bounds total network concurrency even though direct and
  // stable-alias entries receive an additional policy-specific GET.
  const checks = [
    ...urls.map((url) => ({ kind: 'reachability', url })),
    ...catalog
      .filter(({ classification }) => classification === URL_CLASS.DIRECT)
      .map(({ url }) => ({ kind: URL_CLASS.DIRECT, url })),
    ...catalog
      .filter(({ classification }) => classification === URL_CLASS.STABLE_DOCS)
      .map(({ url }) => ({ kind: URL_CLASS.STABLE_DOCS, url })),
  ];
  const results = await mapWithConcurrency(checks, ({ kind, url }) => {
    const options = { fetchImpl };
    if (sleep) options.sleep = sleep;
    if (kind === URL_CLASS.DIRECT) return checkDirectUrl(url, options);
    if (kind === URL_CLASS.STABLE_DOCS) return checkStableDocsAlias(url, options);
    return checkUrl(url, {
      ...options,
      root,
      allowLocalSource: !catalogUrls.has(url),
    });
  });

  const failures = checks
    .map((check, index) => ({ ...check, result: results[index] }))
    .filter(({ result }) => !result.ok);
  const broken = failures.filter(({ kind }) => kind === 'reachability');
  const policyFailures = failures.filter(({ kind }) => kind !== 'reachability');

  if (broken.length === 0 && policyFailures.length === 0) {
    const hosts = [...LINK_HOSTS].join(', ');
    output.log(`All browser-facing links are reachable and catalog policies pass (${hosts}).`);
    return true;
  }

  if (broken.length > 0) {
    output.error('Broken browser-facing links found:');
    for (const { url, result } of broken) {
      const detail = 'status' in result
        ? `${result.method} ${result.status}`
        : result.error;
      output.error(`- ${url} (${detail})`);
      for (const file of urlSources.get(url) ?? []) {
        output.error(`  - ${file}`);
      }
    }
  }

  if (policyFailures.length > 0) {
    output.error('Canonical URL policy failures found:');
    for (const { result } of policyFailures) {
      output.error(`- ${result.error}`);
    }
  }

  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ok = await main();
  if (!ok) process.exitCode = 1;
}
