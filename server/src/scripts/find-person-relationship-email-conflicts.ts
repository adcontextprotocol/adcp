/**
 * Find and optionally merge duplicate person_relationships rows that collide on
 * email. Root cause: when a user's primary email is reassigned via
 * `PUT /api/me/linked-emails/primary` or `mergeUsers`, or when a
 * Slack-seeded relationship and a WorkOS-seeded relationship for the same
 * person are never reconciled, multiple rows end up targeting the same
 * canonical email. This surfaced as a constraint violation in migration 476
 * (#4481); the immediate guard shipped in #4487. This script clears the
 * remaining backlog. Ref: #4488.
 *
 * Merge strategy: delegates to `resolvePersonId`, which picks the oldest row
 * as winner, absorbs the loser's non-null identity fields, sums interaction
 * counts, re-parents `person_events` and `addie_threads`, and deletes the
 * loser — all inside a single `BEGIN … FOR UPDATE … COMMIT`.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/find-person-relationship-email-conflicts.ts
 *   npx tsx server/src/scripts/find-person-relationship-email-conflicts.ts --apply
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console --pty=false -a adcp-docs -C 'node /app/dist/scripts/find-person-relationship-email-conflicts.js'
 *   fly ssh console --pty=false -a adcp-docs -C 'node /app/dist/scripts/find-person-relationship-email-conflicts.js --apply'
 *
 * Prerequisites: DATABASE_URL set.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { resolvePersonId } from '../db/relationship-db.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;

interface ConflictRow {
  skipped_row_id: string;
  workos_user_id: string;
  current_pr_email: string | null;
  target_user_email: string;
  conflicting_row_id: string;
  conflicting_workos_user_id: string | null;
  conflicting_row_created_at: Date;
  skipped_row_created_at: Date;
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  const result = await pool.query<ConflictRow>(`
    SELECT pr.id AS skipped_row_id,
           pr.workos_user_id,
           pr.email AS current_pr_email,
           u.email AS target_user_email,
           other.id AS conflicting_row_id,
           other.workos_user_id AS conflicting_workos_user_id,
           other.created_at AS conflicting_row_created_at,
           pr.created_at AS skipped_row_created_at
      FROM person_relationships pr
      JOIN users u ON pr.workos_user_id = u.workos_user_id
      JOIN person_relationships other
        ON other.email = u.email
       AND other.id <> pr.id
     WHERE pr.email IS DISTINCT FROM u.email
  `);

  // The query can return both (A→B) and (B→A) for the same pair when both rows
  // carry a workos_user_id pointing at users with the same target email.
  // Deduplicate by canonical pair key before iterating.
  const seen = new Set<string>();
  const pairs: ConflictRow[] = [];
  for (const row of result.rows) {
    const key = [row.skipped_row_id, row.conflicting_row_id].sort().join(':');
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push(row);
    }
  }

  type MergedPair = { row: ConflictRow; winnerId: string };
  const merged: MergedPair[] = [];

  for (const row of pairs) {
    if (!dryRun) {
      // Passing both identifiers causes resolvePersonId to match both rows via
      // `workos_user_id = $1 OR email = $2`, then merge them atomically.
      const winnerId = await resolvePersonId({
        workos_user_id: row.workos_user_id,
        email: row.target_user_email,
      });
      merged.push({ row, winnerId });
    }
  }

  console.log(`Mode:      ${dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing changes)'}`);
  console.log(`Scanned:   ${result.rows.length} raw rows from diagnostic query`);
  console.log(`Conflicts: ${pairs.length} unique pair(s)${dryRun ? ' (would merge)' : ''}`);
  if (!dryRun) {
    console.log(`Merged:    ${merged.length}`);
  }

  if (pairs.length > 0) {
    console.log('');
    if (dryRun) {
      console.log('Would merge (oldest row wins per resolvePersonId):');
      for (const row of pairs) {
        console.log(
          `  skipped=${row.skipped_row_id}  target_email=${row.target_user_email}`
          + `  conflicting=${row.conflicting_row_id}`,
        );
      }
    } else {
      console.log('Merged (winner_id is the surviving person_relationships.id):');
      for (const { row, winnerId } of merged) {
        console.log(
          `  winner=${winnerId}  target_email=${row.target_user_email}`
          + `  merged_from=[${row.skipped_row_id}, ${row.conflicting_row_id}]`,
        );
      }
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
