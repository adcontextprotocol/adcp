/**
 * Generate editorial illustrations for all published perspectives that don't have one.
 *
 * Usage:
 *   npx tsx server/src/scripts/generate-perspective-heroes.ts
 *
 * Requires: DATABASE_URL, GEMINI_API_KEY
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import * as illustrationDb from '../db/illustration-db.js';
import { generateIllustration } from '../services/illustration-generator.js';

async function main() {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is required');
    process.exit(1);
  }

  initializeDatabase(dbConfig);
  const pool = getPool();

  try {
    // Find published perspectives without an illustration
    const { rows } = await pool.query<{
      id: string;
      slug: string;
      title: string;
      category: string | null;
      excerpt: string | null;
    }>(
      `SELECT id, slug, title, category, excerpt
       FROM perspectives
       WHERE status = 'published' AND illustration_id IS NULL
       ORDER BY published_at DESC`
    );

    if (rows.length === 0) {
      console.log('All published perspectives already have illustrations.');
      return;
    }

    console.log(`Found ${rows.length} perspectives without illustrations:\n`);
    for (const p of rows) {
      console.log(`  - ${p.title} (${p.slug})`);
    }
    console.log();

    for (const perspective of rows) {
      console.log(`Generating illustration for: ${perspective.title}`);

      try {
        const { imageBuffer, promptUsed } = await generateIllustration({
          title: perspective.title,
          category: perspective.category || undefined,
          excerpt: perspective.excerpt || undefined,
        });

        const illustration = await illustrationDb.createIllustration({
          perspective_id: perspective.id,
          image_data: imageBuffer,
          prompt_used: promptUsed,
          status: 'generated',
        });

        await illustrationDb.approveIllustration(illustration.id, perspective.id);
        console.log(`  Done (${(imageBuffer.length / 1024).toFixed(0)} KB)\n`);
      } catch (err) {
        console.error(`  Failed: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    console.log('Finished.');
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
