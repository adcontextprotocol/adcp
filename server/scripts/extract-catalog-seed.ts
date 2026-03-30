/**
 * Extract property catalog seed data from Scope3 BigQuery.
 *
 * Produces JSONL files for the catalog-seed service:
 *   1. ad-infra.jsonl     — 23K+ ad tech domains classified as ad_infra
 *   2. properties-web.jsonl — 1.7M web domains as property identities
 *   3. properties-app.jsonl — 550K+ app identifiers as property identities
 *   4. links.jsonl          — identifier links from publisher-organized properties
 *
 * Usage: npx tsx server/scripts/extract-catalog-seed.ts [--output-dir /path]
 *
 * Prerequisites: gcloud auth (bokelley@scope3.com)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT = 'swift-catfish-337215';

function bqQuery(sql: string): unknown[] {
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `bq query --project_id=${PROJECT} --use_legacy_sql=false --max_rows=10000000 --format=json '${escaped}'`;
  const result = execSync(cmd, { maxBuffer: 2 * 1024 * 1024 * 1024, encoding: 'utf-8' });
  const trimmed = result.trim();
  if (!trimmed || trimmed === '[]') return [];
  return JSON.parse(trimmed);
}

function mapInventoryType(inventoryType: string, value: string): { type: string; value: string } | null {
  switch (inventoryType) {
    case 'SITE':
      return { type: 'domain', value: value.toLowerCase() };
    case 'GOOGLE_PLAY_STORE':
      if (/^[a-z]/.test(value) && value.includes('.')) {
        return { type: 'android_package', value: value.toLowerCase() };
      }
      return { type: 'google_play_id', value };
    case 'APPLE_APP_STORE':
      if (/^\d+$/.test(value)) {
        return { type: 'apple_app_store_id', value };
      }
      return { type: 'ios_bundle', value: value.toLowerCase() };
    case 'ROKU':
      return { type: 'roku_store_id', value };
    case 'SAMSUNG':
      return { type: 'samsung_app_id', value };
    case 'AMAZON':
      return { type: 'fire_tv_asin', value };
    default:
      return null;
  }
}

// ─── Parse args ──────────────────────────────────────────────────

const outputDir = process.argv.includes('--output-dir')
  ? process.argv[process.argv.indexOf('--output-dir') + 1]
  : path.join(process.cwd(), 'server', 'data', 'catalog-seed');

fs.mkdirSync(outputDir, { recursive: true });

// ─── Step 1: Ad Infrastructure Domains ───────────────────────────

console.log('Step 1: Extracting ad tech domains for ad_infra classification...');

const adTechRows = bqQuery(`
  SELECT DISTINCT d.domain
  FROM \`${PROJECT}.postgres_datastream.public_adtech_platform\` atp
  JOIN \`${PROJECT}.postgres_datastream.public_organization\` o ON atp.organization_id = o.id
  JOIN \`${PROJECT}.postgres_datastream.public_domain\` d ON d.organization_id = o.id
  WHERE atp.is_generic = false
  AND d.domain IS NOT NULL
  AND d.domain_type = 'SITE'
`) as Array<{ domain: string }>;

const adInfraPath = path.join(outputDir, 'ad-infra.jsonl');
const adInfraStream = fs.createWriteStream(adInfraPath);
let adInfraCount = 0;

for (const row of adTechRows) {
  const domain = row.domain.trim().toLowerCase();
  if (!domain || !domain.includes('.')) continue;

  // Skip domains that are clearly publisher properties being sold through ad tech
  // (e.g., cnn.com shows up under Alphabet because GAM serves their ads)
  // We only want the serving/tracking/tag domains
  if (domain.match(/\.(doubleclick|googlesyndication|adsystem|adform|criteo|adnxs|pubmatic|rubiconproject|casalemedia|openx|sharethrough|flashtalking|sizmek|innovid|spotx|moat|doubleverify|integral)\./)) {
    adInfraStream.write(JSON.stringify({
      type: 'classification',
      identifier: { type: 'domain', value: domain },
      classification: 'ad_infra',
      reason: 'Scope3 ad tech platform domain (serving/tracking)',
    }) + '\n');
    adInfraCount++;
    continue;
  }

  // Domains containing ad-tech-specific subdomain patterns
  if (domain.match(/^(ad[sx]?|pixel|tag|track|beacon|sync|match|bid|rtb|imp|stats|static|cdn|js|sdk)\./)) {
    adInfraStream.write(JSON.stringify({
      type: 'classification',
      identifier: { type: 'domain', value: domain },
      classification: 'ad_infra',
      reason: 'Scope3 ad tech platform subdomain pattern',
    }) + '\n');
    adInfraCount++;
    continue;
  }

  // For base domains of ad tech platforms, classify the domain itself
  adInfraStream.write(JSON.stringify({
    type: 'classification',
    identifier: { type: 'domain', value: domain },
    classification: 'ad_infra',
    reason: 'Scope3 ad tech platform domain',
  }) + '\n');
  adInfraCount++;
}

adInfraStream.end();
console.log(`  Wrote ${adInfraCount} ad_infra classifications to ${adInfraPath}`);

// ─── Step 2: Web Domain Properties ───────────────────────────────

console.log('Step 2: Extracting web domains...');

const latestYmd = (bqQuery(`
  SELECT MAX(ymd) as ymd FROM \`${PROJECT}.organizations.property_inventory_mappings\`
`) as Array<{ ymd: string }>)[0].ymd;

console.log(`  Using inventory snapshot from ${latestYmd}`);

const webRows = bqQuery(`
  SELECT DISTINCT inventory_identifier as domain
  FROM \`${PROJECT}.organizations.property_inventory_mappings\`
  WHERE ymd = '${latestYmd}'
  AND channel IN ('DISPLAY-WEB', 'STREAMING-VIDEO', 'DIGITAL-AUDIO')
  AND inventory_type = 'SITE'
  AND inventory_identifier IS NOT NULL
  AND LENGTH(TRIM(inventory_identifier)) > 3
  ORDER BY domain
`) as Array<{ domain: string }>;

const webPath = path.join(outputDir, 'properties-web.jsonl');
const webStream = fs.createWriteStream(webPath);
let webCount = 0;

// Build ad_infra set for exclusion
const adInfraSet = new Set(adTechRows.map(r => r.domain.trim().toLowerCase()));

for (const row of webRows) {
  const domain = row.domain.trim().toLowerCase();
  if (!domain || !domain.includes('.')) continue;
  if (adInfraSet.has(domain)) continue; // Skip domains already classified as ad_infra

  webStream.write(JSON.stringify({
    type: 'property',
    identifiers: [{ type: 'domain', value: domain }],
    classification: 'property',
  }) + '\n');
  webCount++;
}

webStream.end();
console.log(`  Wrote ${webCount} web property records to ${webPath}`);

// ─── Step 3: App Properties ─────────────────────────────────────

console.log('Step 3: Extracting app identifiers...');

const appRows = bqQuery(`
  SELECT DISTINCT inventory_identifier, inventory_type, channel
  FROM \`${PROJECT}.organizations.property_inventory_mappings\`
  WHERE ymd = '${latestYmd}'
  AND inventory_type IN ('GOOGLE_PLAY_STORE', 'APPLE_APP_STORE', 'ROKU', 'SAMSUNG', 'AMAZON')
  AND inventory_identifier IS NOT NULL
  AND LENGTH(TRIM(inventory_identifier)) > 1
  ORDER BY inventory_type, inventory_identifier
`) as Array<{ inventory_identifier: string; inventory_type: string; channel: string }>;

const appPath = path.join(outputDir, 'properties-app.jsonl');
const appStream = fs.createWriteStream(appPath);
let appCount = 0;

for (const row of appRows) {
  const mapped = mapInventoryType(row.inventory_type, row.inventory_identifier.trim());
  if (!mapped) continue;

  appStream.write(JSON.stringify({
    type: 'property',
    identifiers: [mapped],
    classification: 'property',
  }) + '\n');
  appCount++;
}

appStream.end();
console.log(`  Wrote ${appCount} app property records to ${appPath}`);

// ─── Step 4: Publisher-Organized Links ───────────────────────────

console.log('Step 4: Extracting publisher-organized identifier links...');

// Get properties with multiple identifiers (these create linking facts)
const linkRows = bqQuery(`
  SELECT
    organization_id as org_id,
    property_name,
    channel,
    ARRAY_AGG(STRUCT(inventory_type, inventory_identifier)) as identifiers
  FROM \`${PROJECT}.organizations.property_inventory_mappings\`
  WHERE ymd = '${latestYmd}'
  AND inventory_identifier IS NOT NULL
  AND organization_id IS NOT NULL
  GROUP BY organization_id, property_name, channel
  HAVING COUNT(*) > 1 AND COUNT(*) <= 50
  ORDER BY org_id, property_name
`) as Array<{
  org_id: string;
  property_name: string;
  channel: string;
  identifiers: Array<{ inventory_type: string; inventory_identifier: string }>;
}>;

const linksPath = path.join(outputDir, 'links.jsonl');
const linksStream = fs.createWriteStream(linksPath);
let linkCount = 0;

for (const row of linkRows) {
  const mapped = row.identifiers
    .map(i => mapInventoryType(i.inventory_type, i.inventory_identifier.trim()))
    .filter((m): m is { type: string; value: string } => m !== null);

  // Deduplicate
  const seen = new Set<string>();
  const unique = mapped.filter(m => {
    const key = `${m.type}:${m.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length < 2) continue;

  linksStream.write(JSON.stringify({
    type: 'link',
    identifiers: unique,
  }) + '\n');
  linkCount++;
}

linksStream.end();
console.log(`  Wrote ${linkCount} link records to ${linksPath}`);

// ─── Summary ─────────────────────────────────────────────────────

console.log('\n=== Catalog Seed Summary ===');
console.log(`  Ad infra classifications: ${adInfraCount.toLocaleString()}`);
console.log(`  Web property identities:  ${webCount.toLocaleString()}`);
console.log(`  App property identities:  ${appCount.toLocaleString()}`);
console.log(`  Identifier links:         ${linkCount.toLocaleString()}`);
console.log(`  Total records:            ${(adInfraCount + webCount + appCount + linkCount).toLocaleString()}`);
console.log(`  Output directory:         ${outputDir}`);
console.log('\nTo import into the catalog:');
console.log(`  cat ${outputDir}/*.jsonl | npx tsx server/scripts/import-catalog-seed.ts`);
