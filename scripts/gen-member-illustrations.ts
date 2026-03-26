import { generateIllustration } from '../server/src/services/illustration-generator.js';
import pg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: 'postgresql://adcp:localdev@localhost:62576/adcp_registry' });

async function main() {
  // Get the three member-authored articles
  const { rows } = await pool.query(`
    SELECT p.id, p.title, p.category, p.excerpt
    FROM perspectives p
    JOIN content_authors ca ON ca.perspective_id = p.id
    WHERE p.status = 'published' AND p.illustration_id IS NULL
    ORDER BY p.published_at DESC
  `);

  console.log(`Found ${rows.length} member articles without illustrations`);

  for (const p of rows) {
    console.log(`\nGenerating: ${p.title.slice(0, 60)}...`);
    try {
      const { imageBuffer, promptUsed } = await generateIllustration({
        title: p.title,
        category: p.category,
        excerpt: p.excerpt,
      });
      const hex = '\\x' + imageBuffer.toString('hex');
      const ins = await pool.query(
        `INSERT INTO perspective_illustrations (perspective_id, image_data, prompt_used, status, approved_at)
         VALUES ($1, $2, $3, 'approved', NOW()) RETURNING id`,
        [p.id, hex, promptUsed]
      );
      const illId = ins.rows[0].id;
      await pool.query('UPDATE perspectives SET illustration_id = $1 WHERE id = $2', [illId, p.id]);
      console.log(`  OK: ${illId} (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
    } catch (e: any) {
      console.log(`  FAIL: ${e.message}`);
    }
  }

  await pool.end();
}
main();
