import { readFileSync } from 'fs';
import { join } from 'path';
import { globSync } from 'glob';

const LINK_HOST = 'agenticadvertising.org';
const SKIPPED_PATH_PREFIXES = ['/api/'];
const ROOT = process.cwd();

function getCandidateFiles() {
  return globSync(['docs/**/*.{md,mdx}', 'dist/docs/**/*.{md,mdx}', 'README.md'], {
    cwd: ROOT,
    nodir: true,
  }).filter((file) => readFileSync(join(ROOT, file), 'utf8').includes(LINK_HOST));
}

function extractUrls(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const matches = text.match(/https?:\/\/agenticadvertising\.org[^\s)"'>`]+/g) ?? [];
  return [...new Set(matches)];
}

function shouldCheck(url) {
  const parsed = new URL(url);
  return !SKIPPED_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
}

async function fetchStatus(url, method) {
  const response = await fetch(url, {
    method,
    redirect: 'follow',
    headers: {
      'User-Agent': 'adcp-owned-link-check/1.0',
    },
  });

  return response.status;
}

async function checkUrl(url) {
  try {
    const headStatus = await fetchStatus(url, 'HEAD');
    if (headStatus < 400) {
      return { ok: true, status: headStatus, method: 'HEAD' };
    }

    const getStatus = await fetchStatus(url, 'GET');
    return { ok: getStatus < 400, status: getStatus, method: 'GET' };
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
    console.log('All browser-facing agenticadvertising.org links are reachable.');
    return;
  }

  console.error('Broken browser-facing agenticadvertising.org links found:');
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
