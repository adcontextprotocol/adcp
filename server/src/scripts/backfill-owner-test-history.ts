/**
 * Backfill historical owner-triggered `agent_test_history` rows into
 * `agent_compliance_runs` as `triggered_by='owner_test'`. Part of the #4247
 * compliance-state unification — PR #4250 (merged) made
 * `evaluate_agent_quality` write canonical going forward; this script
 * backfills the pre-PR-#4250 rows so the compliance API and dashboard
 * reflect the full owner-test history.
 *
 * ## Usage
 *
 *   # Dry run (default; counts what would land, no writes):
 *   DATABASE_URL=… npx tsx server/src/scripts/backfill-owner-test-history.ts
 *
 *   # Commit, default chunk size:
 *   DATABASE_URL=… npx tsx server/src/scripts/backfill-owner-test-history.ts --commit
 *
 *   # Commit, custom chunk + sleep (for prod-sized tables):
 *   DATABASE_URL=… npx tsx server/src/scripts/backfill-owner-test-history.ts \
 *     --commit --chunk-size 500 --sleep-ms 250
 *
 * ## Env
 *
 *   DATABASE_URL   required
 *
 * ## Safety / chunking strategy
 *
 * - Cutover guard: skips any `agent_test_history` row whose `started_at` is at
 *   or after the earliest `triggered_by='owner_test'` row in
 *   `agent_compliance_runs`. That earliest row is the live-write cutover
 *   point — anything after that timestamp would already have been written
 *   by the runtime canonical path in PR #4250 and re-inserting it here
 *   would duplicate. When no `owner_test` rows exist yet (fresh deploy),
 *   the cutover is treated as `+infinity` and every row is eligible.
 *
 * - Idempotency: each row carries its source `agent_test_history.id` in
 *   `observations_json.backfill_source_id`. The chunk SELECT filters with
 *   `WHERE NOT EXISTS (… backfill_source_id = ath.id)`. Re-running the
 *   script after a partial failure resumes cleanly — already-backfilled
 *   rows are skipped without duplicate writes.
 *
 * - Chunks by primary-key id ascending, --chunk-size at a time. A short
 *   `--sleep-ms` between chunks lets the heartbeat and other writers
 *   keep moving. Default chunk 1000 / sleep 100ms — tune for table size.
 *
 * - Does NOT update `agent_compliance_status`. The runtime canonical
 *   write path in PR #4250 already maintains that row; backfilling
 *   historical runs into the history table should not retroactively
 *   change "current" status.
 */

import { initializeDatabase, closeDatabase, getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('backfill-owner-test-history');

interface Args {
  chunkSize: number;
  sleepMs: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { chunkSize: 1000, sleepMs: 100, dryRun: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--chunk-size') args.chunkSize = parseInt(argv[++i], 10);
    else if (a === '--sleep-ms') args.sleepMs = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--commit') args.dryRun = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: backfill-owner-test-history.ts [--commit] [--chunk-size N] [--sleep-ms N] [--dry-run]');
      process.exit(0);
    } else throw new Error(`Unknown arg: ${a}`);
  }
  if (args.chunkSize <= 0) throw new Error('--chunk-size must be > 0');
  if (args.sleepMs < 0) throw new Error('--sleep-ms must be >= 0');
  return args;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');

  initializeDatabase({ connectionString: process.env.DATABASE_URL });
  const pool = getPool();

  // Cutover: earliest live owner_test write in agent_compliance_runs.
  // Anything in agent_test_history with started_at >= cutover would
  // duplicate a row PR #4250's runtime path already inserted.
  const cutoverRow = await pool.query<{ cutover: Date | null }>(
    `SELECT MIN(tested_at) AS cutover FROM agent_compliance_runs WHERE triggered_by = 'owner_test'`,
  );
  const cutover: Date | null = cutoverRow.rows[0]?.cutover ?? null;
  logger.info(
    { cutover: cutover ? cutover.toISOString() : null, mode: args.dryRun ? 'dry-run' : 'commit' },
    `Backfill starting (cutover = ${cutover ? cutover.toISOString() : 'no canonical owner_test rows yet — backfilling all eligible'})`,
  );

  // Eligible-row count for visibility before commit.
  const eligibleCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM agent_test_history ath
       JOIN agent_contexts ac ON ac.id = ath.agent_context_id
      WHERE ath.user_id IS NOT NULL
        AND ($1::timestamptz IS NULL OR ath.started_at < $1::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM agent_compliance_runs acr
           WHERE acr.observations_json->>'backfill_source_id' = ath.id::text
        )`,
    [cutover],
  );
  const totalEligible = parseInt(eligibleCount.rows[0]?.count ?? '0', 10);
  logger.info({ totalEligible, chunkSize: args.chunkSize }, `${totalEligible} row(s) eligible for backfill`);

  if (totalEligible === 0) {
    logger.info('Nothing to backfill — exiting cleanly.');
    await closeDatabase();
    return;
  }

  let totalInserted = 0;
  let lastId: string | null = null;

  // Chunked loop: pull the next `chunkSize` eligible rows by id ASC, insert
  // them into agent_compliance_runs, advance the cursor. Each chunk is its
  // own short transaction so heartbeat / runtime writes never wait on a
  // long-running backfill lock.
  while (true) {
    const insertResult: { rows: Array<{ inserted_count: number; max_id: string | null }> } = await pool.query<{ inserted_count: number; max_id: string | null }>(
      `WITH eligible AS (
        SELECT ath.*, ac.agent_url
          FROM agent_test_history ath
          JOIN agent_contexts ac ON ac.id = ath.agent_context_id
         WHERE ath.user_id IS NOT NULL
           AND ($1::timestamptz IS NULL OR ath.started_at < $1::timestamptz)
           AND ($2::uuid IS NULL OR ath.id > $2::uuid)
           AND NOT EXISTS (
             SELECT 1 FROM agent_compliance_runs acr
              WHERE acr.observations_json->>'backfill_source_id' = ath.id::text
           )
         ORDER BY ath.id ASC
         LIMIT $3
      ),
      inserted AS (
        INSERT INTO agent_compliance_runs (
          agent_url,
          lifecycle_stage,
          overall_status,
          headline,
          total_duration_ms,
          tracks_json,
          tracks_passed,
          tracks_failed,
          tracks_skipped,
          tracks_partial,
          agent_profile_json,
          observations_json,
          triggered_by,
          dry_run,
          tested_at
        )
        SELECT
          eligible.agent_url,
          COALESCE(arm.lifecycle_stage, 'production'),
          CASE WHEN eligible.overall_passed THEN 'passing' ELSE 'failing' END,
          eligible.summary,
          eligible.total_duration_ms,
          '[]'::jsonb,
          COALESCE(eligible.steps_passed, 0),
          COALESCE(eligible.steps_failed, 0),
          0,
          0,
          eligible.agent_profile_json,
          jsonb_build_object(
            'backfill_source', 'agent_test_history',
            'backfill_source_id', eligible.id::text,
            'backfill_script', 'backfill-owner-test-history',
            'original_scenario', eligible.scenario
          ),
          'owner_test',
          FALSE,
          eligible.started_at
        FROM eligible
        LEFT JOIN agent_registry_metadata arm ON arm.agent_url = eligible.agent_url
        WHERE NOT $4::boolean
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*)::int FROM inserted) AS inserted_count,
        (SELECT MAX(id)::text FROM eligible) AS max_id`,
      [cutover, lastId, args.chunkSize, args.dryRun],
    );

    const chunk = insertResult.rows[0];
    const inserted = chunk?.inserted_count ?? 0;
    const maxId = chunk?.max_id ?? null;

    if (!maxId) break;

    if (args.dryRun) {
      // Dry-run path: cursor still needs to advance via the eligible CTE's
      // max id, but no rows were inserted. Count what WOULD have landed.
      const wouldInsert = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM agent_test_history ath
           JOIN agent_contexts ac ON ac.id = ath.agent_context_id
          WHERE ath.user_id IS NOT NULL
            AND ($1::timestamptz IS NULL OR ath.started_at < $1::timestamptz)
            AND ($2::uuid IS NULL OR ath.id > $2::uuid)
            AND ath.id <= $3::uuid
            AND NOT EXISTS (
              SELECT 1 FROM agent_compliance_runs acr
               WHERE acr.observations_json->>'backfill_source_id' = ath.id::text
            )`,
        [cutover, lastId, maxId],
      );
      const wouldCount = parseInt(wouldInsert.rows[0]?.count ?? '0', 10);
      totalInserted += wouldCount;
      logger.info(
        { chunkInserted: wouldCount, totalInserted, lastId: maxId },
        `[dry-run] would insert ${wouldCount} (cumulative ${totalInserted})`,
      );
    } else {
      totalInserted += inserted;
      logger.info(
        { chunkInserted: inserted, totalInserted, lastId: maxId },
        `chunk landed ${inserted} (cumulative ${totalInserted})`,
      );
    }

    lastId = maxId;

    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }

  logger.info(
    { totalInserted, mode: args.dryRun ? 'dry-run' : 'commit' },
    `Backfill ${args.dryRun ? 'dry-run' : 'commit'} complete — ${totalInserted} row(s) ${args.dryRun ? 'would have been' : ''} inserted`,
  );

  await closeDatabase();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error({ err }, 'backfill-owner-test-history failed');
    console.error(err);
    process.exit(1);
  });
