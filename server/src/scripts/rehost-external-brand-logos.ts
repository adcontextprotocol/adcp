/**
 * Rehost external logo URLs in existing `brands.brand_manifest` rows.
 *
 * The brand-identity write path was updated to download external logo URLs
 * server-side and replace them with our own `/logos/brands/<domain>/<uuid>`
 * paths before writing the manifest. This script applies the same rewrite
 * to rows that were written before that change, so every member's logo
 * renders without the browser hitting a cross-origin CORP block.
 *
 * Walks all rows with `has_brand_manifest = true` and, for each logo URL
 * inside `brand_manifest.brands[*].logos[*]` and `brand_manifest.logos[*]`,
 * downloads the bytes (via SSRF-safe `safeFetch`) and replaces the URL
 * with `getLogoUrl(domain, <new uuid>)`. Failures are logged and the
 * original URL is left in place — the runtime `<img onerror>` fallback
 * still hides the breakage to viewers.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/rehost-external-brand-logos.ts                  # dry-run
 *   npx tsx server/src/scripts/rehost-external-brand-logos.ts --apply          # write
 *   npx tsx server/src/scripts/rehost-external-brand-logos.ts --domain X       # single brand
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/rehost-external-brand-logos.js'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/rehost-external-brand-logos.js --apply'
 *
 * Prerequisites: DATABASE_URL set. BASE_URL set if not on prod (the script
 * uses BASE_URL's hostname to decide "external vs ours").
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { BrandLogoDatabase } from '../db/brand-logo-db.js';
import { rehostExternalLogo } from '../services/brand-logo-service.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
const domainArgIdx = process.argv.indexOf('--domain');
const onlyDomain = domainArgIdx >= 0 ? process.argv[domainArgIdx + 1]?.toLowerCase() : undefined;

interface BrandRow {
  domain: string;
  brand_manifest: Record<string, unknown>;
}

interface LogoEntry {
  url?: unknown;
  [k: string]: unknown;
}

function ourBaseHost(): string {
  const base = process.env.BASE_URL || 'https://agenticadvertising.org';
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return 'agenticadvertising.org';
  }
}

function isExternalHttpsUrl(url: unknown, ourHost: string): url is string {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('data:')) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname.toLowerCase() !== ourHost;
  } catch {
    return false;
  }
}

/**
 * Walk every logo object in a manifest and yield the ones with an external URL.
 * Mutating the returned object's `url` mutates the manifest in place — that's
 * the whole point.
 */
function* externalLogosOf(
  manifest: Record<string, unknown>,
  ourHost: string,
): Generator<{ logo: LogoEntry; location: string }> {
  const brands = manifest.brands;
  if (Array.isArray(brands)) {
    for (let i = 0; i < brands.length; i++) {
      const b = brands[i] as Record<string, unknown> | undefined;
      const logos = b?.logos;
      if (Array.isArray(logos)) {
        for (let j = 0; j < logos.length; j++) {
          const l = logos[j] as LogoEntry | undefined;
          if (l && isExternalHttpsUrl(l.url, ourHost)) {
            yield { logo: l, location: `brands[${i}].logos[${j}]` };
          }
        }
      }
    }
  }
  const topLogos = manifest.logos;
  if (Array.isArray(topLogos)) {
    for (let j = 0; j < topLogos.length; j++) {
      const l = topLogos[j] as LogoEntry | undefined;
      if (l && isExternalHttpsUrl(l.url, ourHost)) {
        yield { logo: l, location: `logos[${j}]` };
      }
    }
  }
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();
  const brandLogoDb = new BrandLogoDatabase();
  const ourHost = ourBaseHost();

  const result = onlyDomain
    ? await pool.query<BrandRow>(
        `SELECT domain, brand_manifest
           FROM brands
          WHERE has_brand_manifest = TRUE
            AND brand_manifest IS NOT NULL
            AND domain = $1`,
        [onlyDomain],
      )
    : await pool.query<BrandRow>(
        `SELECT domain, brand_manifest
           FROM brands
          WHERE has_brand_manifest = TRUE
            AND brand_manifest IS NOT NULL`,
      );

  let scanned = 0;
  let touched = 0;
  let urlsRewritten = 0;
  let urlsLeftAlone = 0;
  const failures: Array<{ domain: string; location: string; url: string }> = [];

  for (const row of result.rows) {
    scanned++;
    const manifest = row.brand_manifest;

    const externals = Array.from(externalLogosOf(manifest, ourHost));
    if (externals.length === 0) continue;

    let changed = false;
    for (const { logo, location } of externals) {
      const before = logo.url as string;
      const after = await rehostExternalLogo(before, row.domain, brandLogoDb, {
        source: 'community',
      });
      if (after === before) {
        urlsLeftAlone++;
        failures.push({ domain: row.domain, location, url: before });
        continue;
      }
      logo.url = after;
      urlsRewritten++;
      changed = true;
      console.log(`  ${row.domain}  ${location}  ${before}  ->  ${after}`);
    }

    if (changed) {
      touched++;
      if (!dryRun) {
        await pool.query(
          `UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2`,
          [JSON.stringify(manifest), row.domain],
        );
      }
    }
  }

  console.log('');
  console.log(`Mode:           ${dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing changes)'}`);
  console.log(`Our host:       ${ourHost}`);
  console.log(`Scope:          ${onlyDomain ? `single brand (${onlyDomain})` : 'all brands with manifests'}`);
  console.log(`Scanned:        ${scanned} brands`);
  console.log(`Brands touched: ${touched}${dryRun ? ' (would touch)' : ''}`);
  console.log(`URLs rewritten: ${urlsRewritten}${dryRun ? ' (would rewrite)' : ''}`);
  console.log(`URLs left:      ${urlsLeftAlone}  (rehost failed — URL stays in manifest)`);

  if (failures.length > 0) {
    console.log('\nLeft-alone URLs (rehost failed; runtime <img onerror> fallback hides these):');
    for (const f of failures) {
      console.log(`  ${f.domain}  ${f.location}  ${f.url}`);
    }
  }
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
