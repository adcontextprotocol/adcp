import { generateIllustration } from '../server/src/services/illustration-generator.js';
import * as db from '../server/src/db/illustration-db.js';
import { initializeDatabase } from '../server/src/db/client.js';
import { getDatabaseConfig } from '../server/src/config.js';

const PERSPECTIVES = [
  {
    id: 'ddbc3aa2-da14-4e94-9811-829ddabedcfe',
    title: "Meta's rogue AI agent passed every identity check — four gaps in enterprise IAM explain why",
    category: 'tech',
    authorDescription: 'A faceless digital figure walking through security gates that glow green, each gate more elaborate but all opening, dark corridors with amber warning lights',
  },
  {
    id: '392f3f31-1ed1-4c4b-9480-9a532101ad14',
    title: "Column: Jensen Huang doesn't need a new chip. He needs a new moat.",
    category: 'business',
    authorDescription: 'A medieval castle moat but made of circuit boards and silicon, warm amber light reflecting off the water, a lone figure on the ramparts',
  },
  {
    id: 'fa8153d0-6a75-4bc7-8ad1-a9cd30cde94d',
    title: 'Meta backtracks on decision to end Horizon Worlds VR after fans speak up',
    category: 'business',
    authorDescription: 'VR headsets floating in space with speech bubbles rising from a crowd below, warm amber and gold tones, a reversal arrow in the sky',
  },
  {
    id: '38484360-3e09-4fc8-b6b4-ec7b8f4b903b',
    title: 'A rogue AI led to a serious security incident at Meta',
    category: 'tech',
    authorDescription: 'A cracked shield with binary code leaking through, dark amber tones with red warning accents, abstract server room in background',
  },
  {
    id: 'b4421e37-d018-40f5-9fde-579b8c8597b0',
    title: "Microsoft's go-to Xbox controller is selling at its best price of the year",
    category: 'tech',
    authorDescription: 'An Xbox controller dissolving into golden price tag confetti, warm amber retail energy, shopping celebration mood',
  },
  {
    id: 'a3985748-6dd8-41d3-8c9a-a576b42ed4e0',
    title: 'FCC Enforcement Chief Offered to Help Brendan Carr Target Disney, Records Show',
    category: 'tech',
    authorDescription: 'Government documents scattered on a desk with a broadcast tower silhouette, amber lamplight, investigative journalism mood',
  },
];

async function main() {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) throw new Error('No DB config');
  await initializeDatabase(dbConfig);
  const { getPool } = await import('../server/src/db/client.js');
  const pool = getPool();

  for (const p of PERSPECTIVES) {
    // Clear old illustration
    await pool.query('UPDATE perspectives SET illustration_id = NULL WHERE id = $1', [p.id]);
    await pool.query('DELETE FROM perspective_illustrations WHERE perspective_id = $1', [p.id]);

    console.log(`\nGenerating: ${p.title.slice(0, 60)}...`);
    const { imageBuffer, promptUsed } = await generateIllustration({
      title: p.title,
      category: p.category,
      authorDescription: p.authorDescription,
    });
    console.log('Generated', (imageBuffer.length / 1024).toFixed(0), 'KB');

    const illustration = await db.createIllustration({
      perspective_id: p.id,
      image_data: imageBuffer,
      prompt_used: promptUsed,
      author_description: p.authorDescription,
      status: 'generated',
    });

    await db.approveIllustration(illustration.id, p.id);
    console.log('Approved:', illustration.id);
  }

  console.log('\nDone!');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
