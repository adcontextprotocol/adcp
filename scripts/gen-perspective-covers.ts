/**
 * Generate cover images for published perspectives that are missing them.
 * Uses the production illustration-generator service (amber editorial palette).
 * Saves as static files to server/public/images/stories/cover-{slug}.png
 */
import { initializeDatabase, getPool } from '../server/src/db/client.js';
import { generateIllustration } from '../server/src/services/illustration-generator.js';
import fs from 'fs';
import path from 'path';

initializeDatabase({ connectionString: process.env.DATABASE_URL! });

const OUTPUT_DIR = path.resolve(import.meta.dirname, '../server/public/images/stories');

async function main() {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT slug, title, category, excerpt, featured_image_url
     FROM perspectives
     WHERE status = 'published'
     ORDER BY published_at DESC`
  );

  // Filter to those without a cover image file on disk (.png or .jpg)
  const missing = rows.filter((p: any) => {
    const base = path.join(OUTPUT_DIR, `cover-${p.slug}`);
    return !fs.existsSync(`${base}.png`) && !fs.existsSync(`${base}.jpg`);
  });

  if (missing.length === 0) {
    console.log('All perspectives have cover images.');
    process.exit(0);
  }

  console.log(`${missing.length} perspectives need cover images:\n`);
  for (const p of missing) {
    console.log(`  - ${p.slug}: ${p.title}`);
  }
  console.log();

  for (const p of missing) {
    const outPath = path.join(OUTPUT_DIR, `cover-${p.slug}.png`);
    console.log(`Generating: ${p.slug}...`);
    try {
      const { imageBuffer } = await generateIllustration({
        title: p.title,
        category: p.category || undefined,
        excerpt: p.excerpt || undefined,
      });
      fs.writeFileSync(outPath, imageBuffer);
      console.log(`  Saved: ${outPath} (${Math.round(imageBuffer.length / 1024)} KB)`);
    } catch (e: any) {
      console.log(`  ERROR: ${e.message.slice(0, 200)}`);
    }
  }

  process.exit(0);
}
main();
