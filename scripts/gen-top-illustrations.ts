import { generateIllustration } from '../server/src/services/illustration-generator.js';
import { initializeDatabase, getPool } from '../server/src/db/client.js';

// Initialize database from env
initializeDatabase({
  connectionString: process.env.DATABASE_URL!,
});

async function main() {
  const pool = getPool();

  const result = await pool.query(
    `SELECT id, title, category, excerpt FROM perspectives
     WHERE status = 'published' AND working_group_id IS NULL AND illustration_id IS NULL
     ORDER BY published_at DESC NULLS LAST
     LIMIT 6`
  );

  console.log(`Found ${result.rows.length} perspectives to illustrate`);

  for (const art of result.rows) {
    console.log(`Generating for: ${art.title.slice(0, 60)}...`);
    try {
      const { imageBuffer, promptUsed } = await generateIllustration({
        title: art.title,
        category: art.category,
        excerpt: art.excerpt,
      });

      // Insert with explicit \\x hex encoding for BYTEA
      const hexData = '\\x' + imageBuffer.toString('hex');

      const insertResult = await pool.query(
        `INSERT INTO perspective_illustrations (perspective_id, image_data, prompt_used, status, approved_at)
         VALUES ($1, decode($2, 'base64'), $3, 'approved', NOW())
         RETURNING id`,
        [art.id, imageBuffer.toString('base64'), promptUsed]
      );
      const illId = insertResult.rows[0].id;

      await pool.query(
        `UPDATE perspectives SET illustration_id = $1 WHERE id = $2`,
        [illId, art.id]
      );

      console.log(`  OK -> ${illId}`);
    } catch (e: any) {
      console.log(`  ERROR: ${e.message.slice(0, 200)}`);
    }
  }
  process.exit(0);
}
main();
