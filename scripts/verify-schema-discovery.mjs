#!/usr/bin/env node
// Post-publication check for the root schema discovery pointers.
//
// Publication is progressive and per-object (RELEASING.md): a successful
// upload step is not evidence that the public URL serves the new bytes. This
// fetches the live documents and fails when they differ from what the
// publication step just produced — the condition that went unnoticed for
// weeks in adcontextprotocol/adcp#8318.
//
// Scope note: this proves the public URL serves this run's document. It does
// not assert that the document names the newest release of every line — a
// line whose newest patch never reached the CDN is deliberately pinned one
// release back by scripts/build-schema-discovery-pointers.cjs, which reports
// the gap as a warning instead.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = 'https://adcontextprotocol.org';
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 6000;
const FETCH_TIMEOUT_MS = 20000;

const POINTER_FIELDS = ['latest', 'latest_stable', 'channel'];
const POINTER_MAPS = ['aliases', 'latest_by_major', 'latest_by_minor'];

const USAGE = [
  'Usage: node scripts/verify-schema-discovery.mjs --expected-index FILE [options]',
  '',
  '  --expected-index FILE   Pointer document the publication step uploaded.',
  '  --expected-latest FILE  Optional schemas/latest.json companion to verify.',
  `  --origin URL            Public origin to verify (default: ${DEFAULT_ORIGIN}).`,
  `  --attempts N            Fetch attempts per document (default: ${DEFAULT_ATTEMPTS}).`,
  `  --delay-ms N            Delay between attempts (default: ${DEFAULT_DELAY_MS}).`,
].join('\n');

export function parseArgs(argv) {
  const options = { origin: DEFAULT_ORIGIN, attempts: DEFAULT_ATTEMPTS, delayMs: DEFAULT_DELAY_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '-h' || flag === '--help') return { help: true };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value\n${USAGE}`);
    i += 1;
    switch (flag) {
      case '--expected-index': options.expectedIndex = value; break;
      case '--expected-latest': options.expectedLatest = value; break;
      case '--origin': options.origin = value.replace(/\/+$/, ''); break;
      case '--attempts': options.attempts = Number.parseInt(value, 10); break;
      case '--delay-ms': options.delayMs = Number.parseInt(value, 10); break;
      default: throw new Error(`Unexpected argument: ${flag}\n${USAGE}`);
    }
  }
  if (!options.expectedIndex) throw new Error(USAGE);
  if (!/^https?:\/\//.test(options.origin)) throw new Error('--origin must be an http(s) URL');
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new Error('--attempts must be a positive integer');
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative integer');
  }
  return options;
}

/**
 * Human-readable pointer differences, used to explain a byte mismatch. An
 * empty array with differing bytes means the pointers agree but something
 * else in the document does, which is still a failure.
 */
export function pointerMismatches(label, expected, actual) {
  const problems = [];
  for (const field of POINTER_FIELDS) {
    if (!Object.hasOwn(expected, field)) continue;
    if (actual?.[field] !== expected[field]) {
      problems.push(`${label}: ${field} is ${JSON.stringify(actual?.[field])}, expected ${JSON.stringify(expected[field])}`);
    }
  }
  for (const map of POINTER_MAPS) {
    if (!Object.hasOwn(expected, map)) continue;
    for (const [key, value] of Object.entries(expected[map])) {
      const served = actual?.[map]?.[key];
      if (served !== value) {
        problems.push(`${label}: ${map}.${key} is ${JSON.stringify(served)}, expected ${JSON.stringify(value)}`);
      }
    }
  }
  return problems;
}

function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Request the canonical URL a consumer requests, not a cache-busted variant.
// `schemas/index.json` is served with `no-cache, must-revalidate` and the CDN
// worker sets `edgeCache: false` for it (workers/artifact-cdn/src/index.js),
// so there is no edge copy to defeat — and checking the canonical URL is the
// only way to verify what consumers actually get.
async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    // A hung CDN request must not stall the deploy job until the runner times out.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function verifySchemaDiscovery(options, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const readText = deps.readText ?? ((file) => readFile(file, 'utf8'));
  const log = deps.log ?? console.log;

  const documents = [
    { label: 'schemas/index.json', path: '/schemas/index.json', file: options.expectedIndex },
  ];
  if (options.expectedLatest) {
    documents.push({ label: 'schemas/latest.json', path: '/schemas/latest.json', file: options.expectedLatest });
  }

  const problems = [];
  for (const document of documents) {
    const expectedText = await readText(document.file);
    const expected = JSON.parse(expectedText);
    const url = `${options.origin}${document.path}`;
    // Propagation is not instant, so retry. Then fail: a pointer that never
    // lands is exactly the defect this check exists to catch.
    let outstanding = [];
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      try {
        const servedText = await fetchText(url, fetchImpl);
        if (servedText === expectedText) {
          outstanding = [];
        } else {
          // Byte equality is the real assertion; the pointer diff only makes
          // the failure readable.
          outstanding = pointerMismatches(document.label, expected, parseOrNull(servedText));
          if (outstanding.length === 0) {
            outstanding = [`${document.label}: pointers match but ${url} does not serve the published bytes`];
          }
        }
      } catch (error) {
        outstanding = [`${document.label}: could not read ${url}: ${error instanceof Error ? error.message : String(error)}`];
      }
      if (outstanding.length === 0) break;
      if (attempt < options.attempts) await sleep(options.delayMs);
    }
    if (outstanding.length > 0) problems.push(...outstanding);
    else log(`✓ ${url} serves the published document`);
  }

  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const problems = await verifySchemaDiscovery(options);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    console.error(
      'The published schema discovery pointers do not match this build. '
      + 'See RELEASING.md "Publication authority and ordering".',
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
