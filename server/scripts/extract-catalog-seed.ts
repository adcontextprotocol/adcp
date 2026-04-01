/**
 * Export Scope3 property catalog data from BigQuery directly to GCS.
 *
 * No data passes through the local machine. BigQuery writes CSV files
 * directly to gs://aao-catalog-seed/, where the server's POST /seed/gcs
 * endpoint reads them.
 *
 * Produces:
 *   1. ad-infra-000000000000.csv       — ad tech domains for ad_infra classification
 *   2. web-properties-000000000000.csv  — web domains as property identities
 *   3. app-properties-000000000000.csv  — app identifiers as property identities
 *
 * Usage:
 *   npx tsx server/scripts/extract-catalog-seed.ts
 *   npx tsx server/scripts/extract-catalog-seed.ts --bucket gs://my-bucket
 *
 * Prerequisites:
 *   gcloud auth (bokelley@scope3.com) with BigQuery + GCS write access
 *
 * After export, trigger the import from the server:
 *   curl -X POST https://adcp.dev/api/registry/catalog/seed/gcs
 */

import { execSync } from 'child_process';

const PROJECT = 'swift-catfish-337215';
const DEFAULT_BUCKET = 'gs://aao-catalog-seed';

const bucket = process.argv.includes('--bucket')
  ? process.argv[process.argv.indexOf('--bucket') + 1]
  : DEFAULT_BUCKET;

if (!/^gs:\/\/[a-z0-9][-a-z0-9_.]*[a-z0-9](\/[a-z0-9][-a-z0-9_.]*)*$/.test(bucket)) {
  console.error(`Invalid bucket URI: ${bucket}`);
  process.exit(1);
}

function bqExport(description: string, sql: string): void {
  console.log(description);
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `bq query --project_id=${PROJECT} --use_legacy_sql=false '${escaped}'`;
  execSync(cmd, { stdio: 'inherit', encoding: 'utf-8' });
}

// ─── Find latest inventory snapshot date ─────────────────────────

console.log('Finding latest inventory snapshot...');
const ymdResult = execSync(
  `bq query --project_id=${PROJECT} --use_legacy_sql=false --format=json ` +
  `'SELECT MAX(ymd) as ymd FROM \`${PROJECT}.organizations.property_inventory_mappings\`'`,
  { encoding: 'utf-8' },
);
const latestYmd = JSON.parse(ymdResult.trim())[0]?.ymd;
if (!latestYmd || !/^\d{4}-\d{2}-\d{2}$/.test(latestYmd)) {
  console.error(`Unexpected ymd value: ${latestYmd}`);
  process.exit(1);
}
console.log(`  Using snapshot from ${latestYmd}\n`);

// ─── Step 1: Ad Infrastructure Domains ───────────────────────────

bqExport('Step 1: Exporting ad tech domains → ad-infra-*.csv', `
  EXPORT DATA OPTIONS(
    uri='${bucket}/ad-infra-*.csv',
    format='CSV',
    overwrite=true,
    header=true
  ) AS
  SELECT DISTINCT LOWER(d.domain) AS domain
  FROM \`${PROJECT}.postgres_datastream.public_adtech_platform\` atp
  JOIN \`${PROJECT}.postgres_datastream.public_organization\` o ON atp.organization_id = o.id
  JOIN \`${PROJECT}.postgres_datastream.public_domain\` d ON d.organization_id = o.id
  WHERE atp.is_generic = false
    AND d.domain IS NOT NULL
    AND d.domain_type = 'SITE'
    AND STRPOS(d.domain, '.') > 0
`);

// ─── Step 2: Web Domain Properties ───────────────────────────────
// Excludes domains already classified as ad infrastructure.

bqExport('Step 2: Exporting web domains → web-properties-*.csv', `
  EXPORT DATA OPTIONS(
    uri='${bucket}/web-properties-*.csv',
    format='CSV',
    overwrite=true,
    header=true
  ) AS
  WITH ad_infra AS (
    SELECT DISTINCT LOWER(d.domain) AS domain
    FROM \`${PROJECT}.postgres_datastream.public_adtech_platform\` atp
    JOIN \`${PROJECT}.postgres_datastream.public_organization\` o ON atp.organization_id = o.id
    JOIN \`${PROJECT}.postgres_datastream.public_domain\` d ON d.organization_id = o.id
    WHERE atp.is_generic = false
      AND d.domain IS NOT NULL
      AND d.domain_type = 'SITE'
  )
  SELECT DISTINCT LOWER(pim.inventory_identifier) AS domain
  FROM \`${PROJECT}.organizations.property_inventory_mappings\` pim
  LEFT JOIN ad_infra ai ON LOWER(pim.inventory_identifier) = ai.domain
  WHERE pim.ymd = '${latestYmd}'
    AND pim.channel IN ('DISPLAY-WEB', 'STREAMING-VIDEO', 'DIGITAL-AUDIO')
    AND pim.inventory_type = 'SITE'
    AND pim.inventory_identifier IS NOT NULL
    AND LENGTH(TRIM(pim.inventory_identifier)) > 3
    AND ai.domain IS NULL
  ORDER BY domain
`);

// ─── Step 3: App Properties ──────────────────────────────────────

bqExport('Step 3: Exporting app identifiers → app-properties-*.csv', `
  EXPORT DATA OPTIONS(
    uri='${bucket}/app-properties-*.csv',
    format='CSV',
    overwrite=true,
    header=true
  ) AS
  SELECT DISTINCT inventory_type, inventory_identifier AS identifier
  FROM \`${PROJECT}.organizations.property_inventory_mappings\`
  WHERE ymd = '${latestYmd}'
    AND inventory_type IN ('GOOGLE_PLAY_STORE', 'APPLE_APP_STORE', 'ROKU', 'SAMSUNG', 'AMAZON')
    AND inventory_identifier IS NOT NULL
    AND LENGTH(TRIM(inventory_identifier)) > 1
  ORDER BY inventory_type, identifier
`);

// ─── Done ────────────────────────────────────────────────────────

console.log('\n=== Export Complete ===');
console.log(`Files written to ${bucket}/`);
console.log('\nTo import into the catalog:');
console.log('  curl -X POST https://adcp.dev/api/registry/catalog/seed/gcs');
