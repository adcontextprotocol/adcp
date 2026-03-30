/**
 * Import catalog seed data from JSONL files into the database.
 *
 * Reads JSONL files produced by extract-catalog-seed.ts and imports them
 * using the catalog-seed service. Processes files in the correct order:
 * 1. ad-infra.jsonl (classifications first — so properties can be excluded)
 * 2. properties-web.jsonl (bulk web domains)
 * 3. properties-app.jsonl (app identifiers)
 * 4. links.jsonl (identifier linking — after properties exist)
 *
 * Usage:
 *   npx tsx server/scripts/import-catalog-seed.ts [--data-dir /path]
 *   npx tsx server/scripts/import-catalog-seed.ts --file ad-infra.jsonl
 *
 * Prerequisites: DATABASE_URL environment variable set
 */

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { importSeedData } from '../src/services/catalog-seed.js';

const ORDERED_FILES = [
  'ad-infra.jsonl',
  'properties-web.jsonl',
  'properties-app.jsonl',
  'links.jsonl',
];

const CHUNK_SIZE = 50_000; // Lines per import batch

async function importFile(filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  console.log(`\nImporting ${fileName}...`);

  if (!fs.existsSync(filePath)) {
    console.log(`  Skipping — file not found: ${filePath}`);
    return;
  }

  const stat = fs.statSync(filePath);
  console.log(`  File size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const rl = createInterface({ input: fs.createReadStream(filePath) });
  let chunk: string[] = [];
  let totalLines = 0;
  let totalCreated = 0;
  let totalLinked = 0;
  let totalClassified = 0;
  let totalErrors = 0;

  for await (const line of rl) {
    chunk.push(line);

    if (chunk.length >= CHUNK_SIZE) {
      const result = await importSeedData(chunk, 'system:scope3_seed');
      totalCreated += result.properties_created;
      totalLinked += result.identifiers_linked;
      totalClassified += result.classifications_recorded;
      totalErrors += result.errors;
      totalLines += chunk.length;
      chunk = [];

      console.log(`  ${totalLines.toLocaleString()} lines processed (${totalCreated.toLocaleString()} properties, ${totalLinked.toLocaleString()} identifiers, ${totalClassified.toLocaleString()} classifications, ${totalErrors} errors)`);
    }
  }

  // Process remaining lines
  if (chunk.length > 0) {
    const result = await importSeedData(chunk, 'system:scope3_seed');
    totalCreated += result.properties_created;
    totalLinked += result.identifiers_linked;
    totalClassified += result.classifications_recorded;
    totalErrors += result.errors;
    totalLines += chunk.length;
  }

  console.log(`  Done: ${totalLines.toLocaleString()} lines → ${totalCreated.toLocaleString()} properties, ${totalLinked.toLocaleString()} identifiers, ${totalClassified.toLocaleString()} classifications, ${totalErrors} errors`);
}

async function main() {
  const singleFile = process.argv.includes('--file')
    ? process.argv[process.argv.indexOf('--file') + 1]
    : null;

  const dataDir = process.argv.includes('--data-dir')
    ? process.argv[process.argv.indexOf('--data-dir') + 1]
    : path.join(process.cwd(), 'server', 'data', 'catalog-seed');

  console.log('=== Catalog Seed Import ===');
  console.log(`Data directory: ${dataDir}`);

  if (singleFile) {
    const filePath = path.isAbsolute(singleFile) ? singleFile : path.join(dataDir, singleFile);
    await importFile(filePath);
  } else {
    for (const fileName of ORDERED_FILES) {
      await importFile(path.join(dataDir, fileName));
    }
  }

  console.log('\n=== Import Complete ===');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
