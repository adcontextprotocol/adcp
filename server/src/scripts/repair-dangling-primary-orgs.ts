/**
 * Repair users whose `primary_organization_id` points at an org that doesn't
 * exist in the local `organizations` table (or that the user has no
 * membership for). The resolver self-heals on the next read after this PR
 * lands; this script clears the backlog in one shot so existing users don't
 * have to round-trip an authenticated page first.
 *
 * For each dangling user, derives a replacement via
 * `resolvePreferredOrganization` (joins `organizations` and `organization_memberships`):
 *   - If a valid replacement exists, repoints the cache.
 *   - If none exists, NULLs out the column so a later membership webhook
 *     can re-trigger the IS-NULL backfill.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/repair-dangling-primary-orgs.ts            # dry-run
 *   npx tsx server/src/scripts/repair-dangling-primary-orgs.ts --apply    # write
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/repair-dangling-primary-orgs.js'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/repair-dangling-primary-orgs.js --apply'
 *
 * Prerequisites: DATABASE_URL set.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { resolvePreferredOrganization } from '../db/users-db.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;

interface DanglingRow {
  workos_user_id: string;
  email: string;
  primary_organization_id: string;
  reason: 'no_org_row' | 'no_membership_row';
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  // Mirror the JOIN logic the resolver now uses: dangling = either the org
  // row is missing, or the membership row is missing for the cached org.
  const result = await pool.query<DanglingRow>(`
    SELECT u.workos_user_id,
           u.email,
           u.primary_organization_id,
           CASE
             WHEN o.workos_organization_id IS NULL THEN 'no_org_row'
             ELSE 'no_membership_row'
           END AS reason
      FROM users u
      LEFT JOIN organizations o
        ON o.workos_organization_id = u.primary_organization_id
      LEFT JOIN organization_memberships om
        ON om.workos_user_id = u.workos_user_id
       AND om.workos_organization_id = u.primary_organization_id
     WHERE u.primary_organization_id IS NOT NULL
       AND (o.workos_organization_id IS NULL OR om.workos_user_id IS NULL)
  `);

  const repointed: Array<{ user: string; from: string; to: string; reason: string }> = [];
  const cleared: Array<{ user: string; from: string; reason: string }> = [];

  for (const row of result.rows) {
    const replacement = await resolvePreferredOrganization(row.workos_user_id);
    if (replacement) {
      repointed.push({
        user: row.workos_user_id,
        from: row.primary_organization_id,
        to: replacement,
        reason: row.reason,
      });
      if (!dryRun) {
        await pool.query(
          `UPDATE users
              SET primary_organization_id = $1, updated_at = NOW()
            WHERE workos_user_id = $2 AND primary_organization_id = $3`,
          [replacement, row.workos_user_id, row.primary_organization_id]
        );
      }
    } else {
      cleared.push({
        user: row.workos_user_id,
        from: row.primary_organization_id,
        reason: row.reason,
      });
      if (!dryRun) {
        await pool.query(
          `UPDATE users
              SET primary_organization_id = NULL, updated_at = NOW()
            WHERE workos_user_id = $1 AND primary_organization_id = $2`,
          [row.workos_user_id, row.primary_organization_id]
        );
      }
    }
  }

  console.log(`Mode:      ${dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing changes)'}`);
  console.log(`Scanned:   ${result.rows.length} users with dangling primary_organization_id`);
  console.log(`Repointed: ${repointed.length}${dryRun ? ' (would repoint)' : ''}`);
  console.log(`Cleared:   ${cleared.length}${dryRun ? ' (would clear)' : ''} (no valid membership — needs WorkOS sync)`);

  if (repointed.length > 0) {
    console.log('\nRepoint plan:');
    for (const r of repointed) {
      console.log(`  ${r.user}  ${r.from} -> ${r.to}  (${r.reason})`);
    }
  }
  if (cleared.length > 0) {
    console.log('\nCleared (no replacement; WorkOS-sync these orgs by hand if the user should still belong):');
    for (const c of cleared) {
      console.log(`  ${c.user}  was: ${c.from}  (${c.reason})`);
    }
  }
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
