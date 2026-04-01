/**
 * One-time migration: Move static perspective files into the perspective_assets table.
 *
 * Migrates:
 * - server/public/images/stories/cover-building-future-of-marketing.png → cover_image
 * - server/public/reports/building-the-future-of-marketing.pdf → report
 *
 * Run: npx tsx server/scripts/migrate-perspective-static-assets.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getPool, initializeDatabase } from '../src/db/client.js';
import { createAsset } from '../src/db/perspective-asset-db.js';

const PERSPECTIVE_SLUG = 'building-future-of-marketing';
const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

const ASSETS = [
  {
    path: 'server/public/images/stories/cover-building-future-of-marketing.png',
    fileName: 'cover.png',
    mimeType: 'image/png',
    assetType: 'cover_image' as const,
  },
  {
    path: 'server/public/reports/building-the-future-of-marketing.pdf',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    assetType: 'report' as const,
  },
];

async function main() {
  initializeDatabase({ connectionString: process.env.DATABASE_URL || '' });
  const pool = getPool();

  // Find the perspective
  const perspResult = await pool.query(
    `SELECT id FROM perspectives WHERE slug = $1`,
    [PERSPECTIVE_SLUG]
  );

  if (perspResult.rows.length === 0) {
    console.log(`Perspective "${PERSPECTIVE_SLUG}" not found — skipping migration.`);
    await pool.end();
    return;
  }

  const perspectiveId = perspResult.rows[0].id;
  console.log(`Found perspective ${perspectiveId} (${PERSPECTIVE_SLUG})`);

  for (const asset of ASSETS) {
    const fullPath = resolve(process.cwd(), asset.path);
    if (!existsSync(fullPath)) {
      console.log(`  Skipping ${asset.path} — file not found`);
      continue;
    }

    const fileData = readFileSync(fullPath);
    console.log(`  Reading ${asset.path} (${(fileData.length / 1024).toFixed(0)} KB)`);

    const result = await createAsset({
      perspective_id: perspectiveId,
      asset_type: asset.assetType,
      file_name: asset.fileName,
      file_mime_type: asset.mimeType,
      file_data: fileData,
    });

    const assetUrl = `${BASE_URL}/api/perspectives/${PERSPECTIVE_SLUG}/assets/${asset.fileName}`;
    console.log(`  Stored as ${result.id} → ${assetUrl}`);

    // Update featured_image_url for cover image
    if (asset.assetType === 'cover_image') {
      await pool.query(
        `UPDATE perspectives SET featured_image_url = $1, updated_at = NOW() WHERE id = $2`,
        [assetUrl, perspectiveId]
      );
      console.log(`  Updated featured_image_url`);
    }
  }

  // Update article content to use new asset URL for report
  const reportUrl = `/api/perspectives/${PERSPECTIVE_SLUG}/assets/report.pdf`;
  await pool.query(
    `UPDATE perspectives
     SET content = REPLACE(content, '/reports/building-the-future-of-marketing.pdf', $1),
         updated_at = NOW()
     WHERE id = $2`,
    [reportUrl, perspectiveId]
  );
  console.log(`  Updated article content link`);

  console.log('Done.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
