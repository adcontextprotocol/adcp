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
 * ## Ops pre-flight
 *
 *   1. Run with `--dry-run` first — eyeball the candidate list.
 *   2. Start small: `--limit 3`, verify the three review cards, then
 *      go wider.
 *   3. Safe to Ctrl-C mid-run; the existing idempotency filter picks
 *      the resumption point automatically.
 *   4. Only one backfill can run at a time (Postgres advisory lock).
 *      If the script refuses with "another run holds the lock", pg
 *      itself will release on connection close — usually just retry.
 *   5. Hard ceiling: without `--force`, max is 50. With `--force`,
 *      absolute max is 200 — chosen to bound Slack rate + Anthropic
 *      spend per invocation.
 *
 * ## Usage
 *
 *   npx tsx server/src/scripts/backfill-member-announcements.ts
 *     [--limit N] [--dry-run] [--force]
 *
 * ## Env
 *
 *   DATABASE_URL                     required
 *   SLACK_EDITORIAL_REVIEW_CHANNEL   required unless --dry-run
 *   APP_URL                          optional, used in profile links
 *   ADDIE_BOT_TOKEN                  required for non-dry-run posts
 *   ANTHROPIC_API_KEY                required for the drafter
 *
 * Prod-admin-only: whoever can run this has shell access, the Addie
 * bot token, and Anthropic billing. No finer-grained authz in-band.
 */

import { initializeDatabase, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import {
  runBackfillAnnouncements,
  BACKFILL_SOFT_CAP,
  BACKFILL_ABSOLUTE_MAX,
  type BackfillPreviewRow,
} from '../addie/jobs/announcement-trigger.js';

interface CliArgs {
  limit: number;
  dryRun: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let limit = 15;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--force') {
      force = true;
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
  return { limit, dryRun, force };
}

const USAGE = `
Usage: npx tsx server/src/scripts/backfill-member-announcements.ts [options]

  --limit <N>   Cap on drafts posted in this run (default 15, max ${BACKFILL_SOFT_CAP}
                without --force; ${BACKFILL_ABSOLUTE_MAX} absolute max with --force)
  --dry-run     Query candidates and print what would be drafted;
                don't post to Slack or write activity rows
  --force       Allow --limit above ${BACKFILL_SOFT_CAP} (still capped at ${BACKFILL_ABSOLUTE_MAX}). Use
                this when you've done a dry-run and accept the blast radius.

Env:
  DATABASE_URL (required)
  SLACK_EDITORIAL_REVIEW_CHANNEL (required unless --dry-run)
  ADDIE_BOT_TOKEN (required unless --dry-run)
  ANTHROPIC_API_KEY (required unless --dry-run)
`;

function formatPreviewRow(r: BackfillPreviewRow): string {
  const tier = r.membership_tier ?? 'no-tier';
  const domain = r.primary_brand_domain ?? 'no-domain';
  const when = r.last_published_at
    ? new Date(r.last_published_at).toISOString().slice(0, 10)
    : 'no-event';
  return `    - ${r.workos_organization_id}  ${r.org_name}  [${tier}·${domain}·${when}]`;
}

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

  if (args.limit > BACKFILL_SOFT_CAP && !args.force) {
    console.error(
      `--limit ${args.limit} exceeds the soft cap of ${BACKFILL_SOFT_CAP}. Pass --force to override (max ${BACKFILL_ABSOLUTE_MAX}).`,
    );
    process.exit(2);
  }

  initializeDatabase(dbConfig);

  try {
    const result = await runBackfillAnnouncements({
      reviewChannel,
      limit: args.limit,
      dryRun: args.dryRun,
      force: args.force,
    });

    if (result.lockedOut) {
      console.error(
        '\nAnother backfill run is already in progress (advisory lock held). Wait for it to finish, or check for a stuck session, and retry.',
      );
      process.exit(3);
    }

    if (result.dryRun) {
      console.log(`\nBackfill dry-run:`);
      console.log(`  Eligible candidates: ${result.candidates}`);
      console.log(
        `  Would draft:         ${result.wouldDraft?.length ?? 0} (effective cap ${result.effectiveLimit})`,
      );
      for (const c of result.wouldDraft ?? []) {
        console.log(formatPreviewRow(c));
      }
      console.log(
        `\nNext step: re-run without --dry-run; start with --limit 3 to verify cards land correctly.`,
      );
    } else {
      console.log(`\nBackfill complete:`);
      console.log(`  Eligible candidates: ${result.candidates}`);
      console.log(`  Drafted:             ${result.drafted}`);
      console.log(`  Failed:              ${result.failed}`);
      if (result.drafted_orgs?.length) {
        console.log(`  Cards posted for:`);
        for (const c of result.drafted_orgs) {
          console.log(formatPreviewRow(c));
        }
      }
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
