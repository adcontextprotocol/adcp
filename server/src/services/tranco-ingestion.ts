/**
 * Tranco Top Sites — validation and corroboration service.
 *
 * Tranco (tranco-list.eu) aggregates Chrome UX Report, Majestic, Cloudflare
 * Radar, and Umbrella over a 30-day rolling window. It's manipulation-resistant
 * and updated daily.
 *
 * We don't ingest Tranco as a seeding pipeline — it's too noisy (CDN hostnames,
 * DNS infrastructure, ad servers, API endpoints). Instead we use it as:
 *
 * 1. **Validation** — when a domain enters the catalog, check Tranco rank.
 *    Present in top 25K = high confidence it's real.
 * 2. **Classification corroboration** — unclassified domain in Tranco top 10K
 *    is probably a real property. Not in Tranco at all = look harder.
 * 3. **Demand signal** — Tranco rank correlates with impression volume.
 */

import { createReadStream } from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createInterface } from 'readline';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlink, mkdir } from 'fs/promises';
import { createLogger } from '../logger.js';

const logger = createLogger('tranco');

const TRANCO_URL = 'https://tranco-list.eu/top-1m.csv.zip';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

// ─── In-Memory Lookup ────────────────────────────────────────────

/** Domain → rank mapping, loaded from the latest Tranco list */
let rankMap: Map<string, number> | null = null;
let lastLoadedAt: number = 0;

export interface TrancoLookupResult {
  domain: string;
  rank: number | null;
  in_top_1k: boolean;
  in_top_10k: boolean;
  in_top_100k: boolean;
  loaded: boolean;
}

/**
 * Look up a single domain's Tranco rank.
 * Returns null rank if domain is not in the list.
 * Returns loaded: false if the list hasn't been loaded yet.
 */
export function lookupTrancoRank(domain: string): TrancoLookupResult {
  const normalized = domain.toLowerCase().replace(/^www\./, '');

  if (!rankMap) {
    return { domain: normalized, rank: null, in_top_1k: false, in_top_10k: false, in_top_100k: false, loaded: false };
  }

  const rank = rankMap.get(normalized) ?? null;
  return {
    domain: normalized,
    rank,
    in_top_1k: rank !== null && rank <= 1000,
    in_top_10k: rank !== null && rank <= 10000,
    in_top_100k: rank !== null && rank <= 100000,
    loaded: true,
  };
}

/**
 * Batch lookup for multiple domains. Efficient — single map lookup per domain.
 */
export function lookupTrancoRanks(domains: string[]): Map<string, TrancoLookupResult> {
  const results = new Map<string, TrancoLookupResult>();
  for (const domain of domains) {
    results.set(domain, lookupTrancoRank(domain));
  }
  return results;
}

/**
 * Check if the Tranco list is loaded and fresh.
 */
export function isTrancoLoaded(): boolean {
  return rankMap !== null && (Date.now() - lastLoadedAt) < CACHE_MAX_AGE_MS;
}

// ─── Loading ─────────────────────────────────────────────────────

export interface TrancoLoadResult {
  total_domains: number;
  load_time_ms: number;
  top_infra_sample: string[];
}

/**
 * Download and load the Tranco list into memory.
 * The full 1M list is ~20MB as CSV, ~40MB in a Map. Acceptable for a server process.
 * Call this on startup or on a daily schedule.
 */
export async function loadTrancoList(): Promise<TrancoLoadResult> {
  const start = Date.now();
  const csvPath = await downloadAndExtract();

  try {
    const newMap = new Map<string, number>();
    const rl = createInterface({ input: createReadStream(csvPath) });

    for await (const line of rl) {
      const comma = line.indexOf(',');
      if (comma === -1) continue;
      const rank = parseInt(line.substring(0, comma), 10);
      const domain = line.substring(comma + 1).trim().toLowerCase();
      if (!isNaN(rank) && domain) {
        newMap.set(domain, rank);
      }
    }

    rankMap = newMap;
    lastLoadedAt = Date.now();

    const loadTime = Date.now() - start;
    logger.info(`Tranco list loaded: ${newMap.size} domains in ${loadTime}ms`);

    return {
      total_domains: newMap.size,
      load_time_ms: loadTime,
      top_infra_sample: [],
    };
  } finally {
    await unlink(csvPath).catch(() => {});
  }
}

async function downloadAndExtract(): Promise<string> {
  const workDir = join(tmpdir(), 'tranco-' + Date.now());
  await mkdir(workDir, { recursive: true });
  const zipPath = join(workDir, 'top-1m.csv.zip');
  const csvPath = join(workDir, 'top-1m.csv');

  logger.info(`Downloading Tranco list from ${TRANCO_URL}`);

  const response = await fetch(TRANCO_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Tranco list: ${response.status} ${response.statusText}`);
  }

  const fileStream = createWriteStream(zipPath);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('unzip', ['-o', zipPath, '-d', workDir]);

  await unlink(zipPath).catch(() => {});

  logger.info('Tranco list downloaded and extracted');
  return csvPath;
}

// ─── Classification Helpers ──────────────────────────────────────

/**
 * Suggest whether a domain is likely a real property based on Tranco data.
 * This is a hint, not a determination — other pipelines make the final call.
 */
export function trancoClassificationHint(domain: string): {
  suggestion: 'likely_property' | 'likely_infra' | 'unknown';
  reason: string;
} {
  const result = lookupTrancoRank(domain);

  if (!result.loaded) {
    return { suggestion: 'unknown', reason: 'Tranco list not loaded' };
  }

  if (result.rank === null) {
    return { suggestion: 'unknown', reason: 'Not in Tranco top 1M' };
  }

  // Known infra patterns — these are in Tranco but are not properties
  const infraPatterns = /cdn|akamai|cloudflare|amazonaws|gstatic|fbcdn|doubleclick|googlesyndication|analytics|adsystem|adnxs|criteo|pubmatic|rubiconproject|casalemedia|demdex|adsrvr|scorecardresearch|openx|taboola|outbrain|flashtalking|moat|doubleverify|integral/i;

  if (infraPatterns.test(domain)) {
    return { suggestion: 'likely_infra', reason: `Tranco rank ${result.rank} but matches known infra pattern` };
  }

  if (result.in_top_10k) {
    return { suggestion: 'likely_property', reason: `Tranco rank ${result.rank} — significant sustained traffic` };
  }

  if (result.in_top_100k) {
    return { suggestion: 'likely_property', reason: `Tranco rank ${result.rank} — moderate traffic` };
  }

  return { suggestion: 'unknown', reason: `Tranco rank ${result.rank} — in list but low rank` };
}
