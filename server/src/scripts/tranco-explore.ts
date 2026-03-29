/**
 * Tranco exploration script.
 *
 * Loads the Tranco list, applies classification hints, and reports
 * what the catalog would look like if we ingested it.
 *
 * Usage: npx tsx server/src/scripts/tranco-explore.ts [--max-rank 25000] [--check-ads-txt 100]
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, unlink, stat } from 'fs/promises';

const TRANCO_URL = 'https://tranco-list.eu/top-1m.csv.zip';

// ─── Known patterns ──────────────────────────────────────────────

const AD_INFRA_PATTERNS = [
  // Ad serving
  /doubleclick/i, /googlesyndication/i, /googleadservices/i, /google-analytics/i,
  /googletagmanager/i, /googletagservices/i, /adsystem/i, /adservice/i,
  // Programmatic
  /adnxs/i, /criteo/i, /pubmatic/i, /rubiconproject/i, /casalemedia/i,
  /openx/i, /sharethrough/i, /indexexchange/i, /adsrvr/i, /bidswitch/i,
  /spotxchange/i, /smartadserver/i, /lijit/i, /contextweb/i, /yieldmo/i,
  // Verification / measurement
  /doubleverify/i, /scorecardresearch/i, /moat/i, /integral-ad/i,
  /demdex/i, /omtrdc/i, /krxd/i, /bluekai/i,
  // Ad creative / serving
  /flashtalking/i, /sizmek/i, /innovid/i, /celtra/i, /jivox/i,
  // Rich media / video
  /springserve/i, /freewheel/i, /spotx/i,
  // Consent / privacy
  /onetrust/i, /cookielaw/i, /quantcast/i, /evidon/i,
  // Retargeting
  /taboola/i, /outbrain/i, /revcontent/i, /mgid/i,
];

const CDN_INFRA_PATTERNS = [
  /cdn/i, /akamai/i, /cloudflare/i, /cloudfront/i, /fastly/i,
  /edgecast/i, /stackpath/i, /limelight/i, /bunnycdn/i,
  /gstatic/i, /fbcdn/i, /twimg/i, /mzstatic/i, /tiktokcdn/i,
  /ytimg/i, /scdn\.co/i, /akamaized/i, /azureedge/i,
  /amazonaws/i, /staticflickr/i,
];

const INFRA_PATTERNS = [
  /gtld-servers/i, /dns/i, /nameserver/i, /ns[0-9]/i,
  /whois/i, /registrar/i, /registry/i,
  // API / platform infra
  /firebaseio/i, /herokuapp/i, /netlify/i, /vercel/i,
  /azurewebsites/i, /appspot/i,
  // Email
  /mailchimp/i, /sendgrid/i, /mailgun/i,
  // Auth / identity
  /auth0/i, /okta/i, /onelogin/i,
];

const PUBLISHER_MASK_DOMAINS = new Set([
  'microsoftadvertising.com',
  'safeframe.googlesyndication.com',
]);

type Classification = 'property' | 'ad_infra' | 'cdn_infra' | 'platform_infra' | 'publisher_mask' | 'social_platform' | 'search_engine' | 'unknown';

const SOCIAL_PLATFORMS = new Set([
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'tiktok.com', 'reddit.com', 'pinterest.com', 'snapchat.com', 'tumblr.com',
  'discord.com', 'twitch.tv', 'threads.net',
]);

const SEARCH_ENGINES = new Set([
  'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'baidu.com',
  'yandex.ru', 'yandex.com',
]);

function classify(domain: string): { classification: Classification; reason: string } {
  if (PUBLISHER_MASK_DOMAINS.has(domain)) {
    return { classification: 'publisher_mask', reason: 'Known publisher mask' };
  }
  if (SOCIAL_PLATFORMS.has(domain)) {
    return { classification: 'social_platform', reason: 'Social platform' };
  }
  if (SEARCH_ENGINES.has(domain)) {
    return { classification: 'search_engine', reason: 'Search engine' };
  }

  for (const pattern of AD_INFRA_PATTERNS) {
    if (pattern.test(domain)) {
      return { classification: 'ad_infra', reason: `Matches ad infra pattern: ${pattern}` };
    }
  }
  for (const pattern of CDN_INFRA_PATTERNS) {
    if (pattern.test(domain)) {
      return { classification: 'cdn_infra', reason: `Matches CDN pattern: ${pattern}` };
    }
  }
  for (const pattern of INFRA_PATTERNS) {
    if (pattern.test(domain)) {
      return { classification: 'platform_infra', reason: `Matches infra pattern: ${pattern}` };
    }
  }

  return { classification: 'unknown', reason: 'No pattern match' };
}

// ─── ads.txt check ───────────────────────────────────────────────

async function checkAdsTxt(domain: string): Promise<{ has_ads_txt: boolean; seller_count: number; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://${domain}/ads.txt`, {
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { has_ads_txt: false, seller_count: 0 };
    }

    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const sellerLines = lines.filter(l => l.includes(','));
    return { has_ads_txt: true, seller_count: sellerLines.length };
  } catch (err) {
    return { has_ads_txt: false, seller_count: 0, error: err instanceof Error ? err.message : 'unknown' };
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const maxRank = parseInt(args.find((_a, i) => args[i - 1] === '--max-rank') || '25000', 10);
  const adsTxtSample = parseInt(args.find((_a, i) => args[i - 1] === '--check-ads-txt') || '0', 10);

  console.log(`\n=== Tranco Exploration ===`);
  console.log(`Max rank: ${maxRank.toLocaleString()}`);
  console.log(`ads.txt sample: ${adsTxtSample}\n`);

  // Download
  const csvPath = await downloadTranco();

  // Load and classify
  const rl = createInterface({ input: createReadStream(csvPath) });
  const stats: Record<Classification, { count: number; examples: string[] }> = {
    property: { count: 0, examples: [] },
    ad_infra: { count: 0, examples: [] },
    cdn_infra: { count: 0, examples: [] },
    platform_infra: { count: 0, examples: [] },
    publisher_mask: { count: 0, examples: [] },
    social_platform: { count: 0, examples: [] },
    search_engine: { count: 0, examples: [] },
    unknown: { count: 0, examples: [] },
  };

  const unknowns: Array<{ rank: number; domain: string }> = [];
  let processed = 0;

  for await (const line of rl) {
    const comma = line.indexOf(',');
    if (comma === -1) continue;
    const rank = parseInt(line.substring(0, comma), 10);
    if (rank > maxRank) break;

    const domain = line.substring(comma + 1).trim().toLowerCase();
    const { classification } = classify(domain);

    stats[classification].count++;
    if (stats[classification].examples.length < 10) {
      stats[classification].examples.push(`${rank}: ${domain}`);
    }

    if (classification === 'unknown') {
      unknowns.push({ rank, domain });
    }

    processed++;
  }

  // Report
  console.log(`Processed ${processed.toLocaleString()} domains\n`);

  console.log('=== Classification Breakdown ===\n');
  const total = processed;
  for (const [cls, data] of Object.entries(stats)) {
    if (data.count === 0) continue;
    const pct = ((data.count / total) * 100).toFixed(1);
    console.log(`${cls}: ${data.count.toLocaleString()} (${pct}%)`);
    for (const ex of data.examples.slice(0, 5)) {
      console.log(`  ${ex}`);
    }
    console.log();
  }

  console.log(`=== Unknown domains (likely properties or need investigation) ===`);
  console.log(`Total: ${unknowns.length.toLocaleString()} (${((unknowns.length / total) * 100).toFixed(1)}%)\n`);

  console.log('Sample unknowns by rank tier:');
  const tiers = [
    { label: 'Top 100', domains: unknowns.filter(d => d.rank <= 100).slice(0, 10) },
    { label: 'Rank 100-1K', domains: unknowns.filter(d => d.rank > 100 && d.rank <= 1000).slice(0, 10) },
    { label: 'Rank 1K-5K', domains: unknowns.filter(d => d.rank > 1000 && d.rank <= 5000).slice(0, 10) },
    { label: 'Rank 5K-10K', domains: unknowns.filter(d => d.rank > 5000 && d.rank <= 10000).slice(0, 10) },
    { label: 'Rank 10K-25K', domains: unknowns.filter(d => d.rank > 10000 && d.rank <= 25000).slice(0, 10) },
  ];

  for (const tier of tiers) {
    console.log(`\n  ${tier.label}:`);
    for (const d of tier.domains) {
      console.log(`    ${d.rank}: ${d.domain}`);
    }
  }

  // ads.txt sampling
  if (adsTxtSample > 0) {
    console.log(`\n=== ads.txt Check (sampling ${adsTxtSample} unknown domains) ===\n`);

    // Sample across rank tiers
    const sample = [
      ...unknowns.filter(d => d.rank <= 500).slice(0, Math.ceil(adsTxtSample * 0.3)),
      ...unknowns.filter(d => d.rank > 500 && d.rank <= 5000).slice(0, Math.ceil(adsTxtSample * 0.3)),
      ...unknowns.filter(d => d.rank > 5000).slice(0, Math.ceil(adsTxtSample * 0.4)),
    ].slice(0, adsTxtSample);

    let hasAdsTxt = 0;
    let noAdsTxt = 0;
    let errors = 0;

    for (const d of sample) {
      const result = await checkAdsTxt(d.domain);
      if (result.has_ads_txt) {
        hasAdsTxt++;
        console.log(`  ✓ ${d.rank}: ${d.domain} — ${result.seller_count} sellers`);
      } else if (result.error) {
        errors++;
        console.log(`  ✗ ${d.rank}: ${d.domain} — ${result.error}`);
      } else {
        noAdsTxt++;
        console.log(`  - ${d.rank}: ${d.domain} — no ads.txt`);
      }
    }

    console.log(`\nads.txt results: ${hasAdsTxt} have it, ${noAdsTxt} don't, ${errors} errors`);
    console.log(`${((hasAdsTxt / (hasAdsTxt + noAdsTxt)) * 100).toFixed(0)}% of reachable domains have ads.txt (ad-supported)`);
  }

  // Cleanup
  await unlink(csvPath).catch(() => {});
}

async function downloadTranco(): Promise<string> {
  const workDir = join(tmpdir(), 'tranco-explore-' + Date.now());
  await mkdir(workDir, { recursive: true });
  const zipPath = join(workDir, 'top-1m.csv.zip');
  const csvPath = join(workDir, 'top-1m.csv');

  // Check if we already have a recent download
  const cachedPath = '/tmp/tranco/top-1m.csv';
  try {
    const s = await stat(cachedPath);
    if (Date.now() - s.mtimeMs < 24 * 60 * 60 * 1000) {
      console.log('Using cached Tranco list');
      return cachedPath;
    }
  } catch { /* not cached */ }

  console.log('Downloading Tranco list...');
  const response = await fetch(TRANCO_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  const fileStream = createWriteStream(zipPath);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  await promisify(execFile)('unzip', ['-o', zipPath, '-d', workDir]);
  await unlink(zipPath).catch(() => {});

  return join(workDir, 'top-1m.csv');
}

main().catch(console.error);
