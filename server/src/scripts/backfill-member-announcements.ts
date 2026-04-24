/**
 * Backfill one-shot: post retroactive new-member announcement drafts
 * to the editorial review channel (Workflow B Stage 4 spec).
 *
 * Queries announce-ready orgs that never had the live trigger fire for
 * them (typically because they went public before the `profile_published`
 * event was added), caps at --limit, and posts each through the same
 * pipeline as the hourly trigger job. Review cards are tagged
 * `[BACKFILL]` so editorial can tell them apart from the live flow.
 * Approval uses the same Slack buttons; no separate surface.
 *
 * Usage:
 *   npx tsx server/src/scripts/backfill-member-announcements.ts
 *     [--limit 10] [--dry-run]
 *
 * Env:
 *   DATABASE_URL                     required
 *   SLACK_EDITORIAL_REVIEW_CHANNEL   required unless --dry-run
 *   APP_URL                          optional, used in profile links
 *   ADDIE_BOT_TOKEN                  required for non-dry-run posts
 *   ANTHROPIC_API_KEY                required for the drafter
 *
 * Safe-to-retry: idempotency on `announcement_draft_posted` means
 * re-running the script will not re-draft orgs that landed last run.
 */

import { initializeDatabase, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { runBackfillAnnouncements } from '../addie/jobs/announcement-trigger.js';

interface CliArgs {
  limit: number;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let limit = 15;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--limit') {
      const next = argv[i + 1];
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
        i++;
      } else {
        throw new Error(`--limit requires a positive integer, got: ${next}`);
      }
    } else if (a.startsWith('--limit=')) {
      const parsed = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      } else {
        throw new Error(`--limit requires a positive integer, got: ${a}`);
      }
    } else if (a === '-h' || a === '--help') {
      // Surfacing as an error throws us out of parse cleanly; main()
      // catches and exits 0 after printing the usage string.
      throw new Error('--help');
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { limit, dryRun };
}

const USAGE = `
Usage: npx tsx server/src/scripts/backfill-member-announcements.ts [options]

  --limit <N>   Cap on drafts posted in this run (default 15)
  --dry-run     Query candidates and print what would be drafted;
                don't post to Slack or write activity rows

Env:
  DATABASE_URL (required)
  SLACK_EDITORIAL_REVIEW_CHANNEL (required unless --dry-run)
  ADDIE_BOT_TOKEN (required unless --dry-run)
  ANTHROPIC_API_KEY (required unless --dry-run)
`;

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === '--help') {
      console.log(USAGE.trim());
      process.exit(0);
    }
    console.error(msg);
    console.error(USAGE.trim());
    process.exit(2);
  }

  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const reviewChannel = process.env.SLACK_EDITORIAL_REVIEW_CHANNEL ?? '';
  if (!args.dryRun && !reviewChannel) {
    console.error('SLACK_EDITORIAL_REVIEW_CHANNEL is required unless --dry-run');
    process.exit(1);
  }

  initializeDatabase(dbConfig);

  try {
    const result = await runBackfillAnnouncements({
      reviewChannel,
      limit: args.limit,
      dryRun: args.dryRun,
    });

    if (result.dryRun) {
      console.log(`\nBackfill dry-run:`);
      console.log(`  Eligible candidates: ${result.candidates}`);
      console.log(`  Would draft:         ${result.wouldDraft?.length ?? 0} (cap ${args.limit})`);
      for (const c of result.wouldDraft ?? []) {
        console.log(`    - ${c.workos_organization_id}  ${c.org_name}`);
      }
    } else {
      console.log(`\nBackfill complete:`);
      console.log(`  Eligible candidates: ${result.candidates}`);
      console.log(`  Drafted:             ${result.drafted}`);
      console.log(`  Failed:              ${result.failed}`);
    }
  } finally {
    await closeDatabase();
  }
}

// Only run when invoked directly (not when imported by a test).
// Narrow check: we only want to fire `main()` when tsx/node launched
// this file as the entry point. Any broader heuristic risks a test
// runner whose argv[1] happens to end in this filename auto-executing
// the script.
const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;

if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
