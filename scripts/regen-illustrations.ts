import { generateIllustration } from '../server/src/services/illustration-generator.js';
import pg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: 'postgresql://adcp:localdev@localhost:62576/adcp_registry' });

const IDS = [
  '4e16de85-8a3e-4a1c-a9c8-0968479ce9fd',
  '408949be-a744-465b-a83b-5d2bc30e6a27',
  '4be400c6-e9a1-4bf9-9c83-6465df6422ea',
  '29a6bbaa-a3d3-451b-beaa-5e65860c65d8',
  '5b66f9a7-7a1a-4e3c-a988-8374e57180f9',
  'b7b45f58-c363-40ab-87ff-bf74a8249f96',
];

async function main() {
  for (const id of IDS) {
    const { rows } = await pool.query('SELECT title, category, excerpt FROM perspectives WHERE id = $1', [id]);
    if (!rows[0]) { console.log(`SKIP ${id} - not found`); continue; }
    const { title, category, excerpt } = rows[0];
    console.log(`Generating: ${title.slice(0, 60)}...`);
    try {
      const { imageBuffer, promptUsed } = await generateIllustration({ title, category, excerpt });
      const hex = '\\x' + imageBuffer.toString('hex');
      const ins = await pool.query(
        `INSERT INTO perspective_illustrations (perspective_id, image_data, prompt_used, status, approved_at)
         VALUES ($1, $2, $3, 'approved', NOW()) RETURNING id`,
        [id, hex, promptUsed]
      );
      const illId = ins.rows[0].id;
      await pool.query('UPDATE perspectives SET illustration_id = $1 WHERE id = $2', [illId, id]);
      console.log(`  OK: ${illId} (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
    } catch (e: any) {
      console.log(`  FAIL: ${e.message}`);
    }
  }
  await pool.end();
}
main();
