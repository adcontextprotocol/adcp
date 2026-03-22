import { generatePortrait } from '../server/src/services/portrait-generator.js';
import pg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: 'postgresql://adcp:localdev@localhost:62576/adcp_registry' });

const SEED_MEMBERS = [
  { orgId: 'org_seed_june_001', name: 'June Cheung', vibe: 'boardroom', palette: 'amber' },
  { orgId: 'org_seed_marcus_001', name: 'Marcus Chen', vibe: 'at-my-desk', palette: 'blue' },
  { orgId: 'org_seed_sarah_001', name: 'Sarah Kim', vibe: 'on-stage', palette: 'amber' },
];

async function main() {
  for (const member of SEED_MEMBERS) {
    console.log(`\nGenerating portrait: ${member.name} (${member.vibe}, ${member.palette})...`);

    // Get member_profile id
    const { rows } = await pool.query(
      'SELECT id FROM member_profiles WHERE workos_organization_id = $1',
      [member.orgId]
    );
    if (!rows[0]) { console.log(`  SKIP: no profile for ${member.orgId}`); continue; }
    const profileId = rows[0].id;

    try {
      const { imageBuffer, promptUsed } = await generatePortrait({
        vibe: member.vibe,
        palette: member.palette,
      });

      const hex = '\\x' + imageBuffer.toString('hex');
      const ins = await pool.query(
        `INSERT INTO member_portraits (member_profile_id, image_url, portrait_data, prompt_used, vibe, palette, status, approved_at)
         VALUES ($1, '', $2, $3, $4, $5, 'approved', NOW()) RETURNING id`,
        [profileId, hex, promptUsed, member.vibe, member.palette]
      );
      const portraitId = ins.rows[0].id;

      // Set portrait_id on member_profiles
      await pool.query('UPDATE member_profiles SET portrait_id = $1 WHERE id = $2', [portraitId, profileId]);

      console.log(`  OK: ${portraitId} (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
    } catch (e: any) {
      console.log(`  FAIL: ${e.message}`);
    }
  }

  await pool.end();
}
main();
