import { readFileSync } from 'fs';
import { join } from 'path';
import { globSync } from 'glob';

const LINK_HOSTS = new Set(['agenticadvertising.org', 'docs.adcontextprotocol.org']);
const SKIPPED_PATH_PREFIXES = ['/api/'];
const ROOT = process.cwd();

function getCandidateFiles() {
  return globSync(
    [
      'docs/**/*.{md,mdx}',
      'dist/docs/**/*.{md,mdx}',
      'README.md',
      'server/src/addie/rules/*.md',
      'server/src/addie/**/*.ts',
    ],
    { cwd: ROOT, nodir: true },
  );
}

// Match http(s) URLs but stop at characters that typically wrap them in source:
// whitespace, quotes, closing brackets, backticks, markdown/slack link syntax (|, ]),
// template interpolation starts (${), and escape starts (\).
function extractUrls(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const matches = text.match(/https?:\/\/[^\s)"'>`\\|\]]+/g) ?? [];

  return [...new Set(matches)]
    .map((url) => url.replace(/[.,;:!?]+$/, ''))
    .filter((url) => !url.includes('${'))
    .filter((url) => {
      try {
        return LINK_HOSTS.has(new URL(url).hostname);
      } catch {
        return false;
      }
    });
}

function shouldCheck(url) {
  const parsed = new URL(url);
  return !SKIPPED_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
}

async function fetchStatus(url, method, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        redirect: 'follow',
        headers: {
          'User-Agent': 'adcp-owned-link-check/1.0',
        },
      });
      if (response.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return response.status;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// 405 means the endpoint exists but rejects this HTTP method (e.g. MCP
// Streamable-HTTP endpoints reject GET). Treat as reachable.
function isReachableStatus(status) {
  return status < 400 || status === 405;
}

async function checkUrl(url) {
  try {
    const headStatus = await fetchStatus(url, 'HEAD');
    if (isReachableStatus(headStatus)) {
      return { ok: true, status: headStatus, method: 'HEAD' };
    }

    const getStatus = await fetchStatus(url, 'GET');
    return { ok: isReachableStatus(getStatus), status: getStatus, method: 'GET' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const urlSources = new Map();

  for (const file of getCandidateFiles()) {
    for (const url of extractUrls(file)) {
      if (!shouldCheck(url)) {
        continue;
      }

      const existing = urlSources.get(url) ?? [];
      existing.push(file);
      urlSources.set(url, existing);
    }
  }

  const broken = [];

  for (const url of [...urlSources.keys()].sort()) {
    const result = await checkUrl(url);
    if (result.ok) {
      continue;
    }

    broken.push({ url, result, files: urlSources.get(url) ?? [] });
  }

  if (broken.length === 0) {
    const hosts = [...LINK_HOSTS].join(', ');
    console.log(`All browser-facing links are reachable (${hosts}).`);
    return;
  }

  console.error('Broken browser-facing links found:');
  for (const { url, result, files } of broken) {
    const detail =
      'status' in result
        ? `${result.method} ${result.status}`
        : result.error;
    console.error(`- ${url} (${detail})`);
    for (const file of files) {
      console.error(`  - ${file}`);
    }
  }

  process.exitCode = 1;
}

await main();
