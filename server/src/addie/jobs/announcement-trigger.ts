/**
 * Announcement Trigger Job (Workflow B Stage 1)
 *
 * Finds members who have become announce-ready (`profile_published`
 * activity recorded, `is_public = true`, brand.json manifest present)
 * and no draft has been posted yet. Drafts a welcome post via
 * `announcement-drafter`, resolves a visual, and posts a Block Kit
 * review card to `#admin-editorial-review` for HITL approval.
 *
 * Records `announcement_draft_posted` activity on success for
 * idempotency. Stage 2 handlers read that row's metadata to publish
 * the approved copy.
 *
 * Post-then-record ordering: Slack post first, activity write second.
 * If the activity write fails we delete the Slack message so the next
 * run re-drafts cleanly instead of leaving an orphan review card with
 * no idempotency row (which would produce duplicate posts).
 */

import { createLogger } from '../../logger.js';
import { query, getPool } from '../../db/client.js';
import { sendChannelMessage, deleteChannelMessage } from '../../slack/client.js';
import { draftAnnouncement } from '../../services/announcement-drafter.js';
import {
  resolveAnnouncementVisual,
  type VisualResolution,
} from '../../services/announcement-visual.js';
import { getEditorialChannel } from '../../db/system-settings-db.js';
import type { SlackBlock, SlackElement } from '../../slack/types.js';

const logger = createLogger('announcement-trigger');

const MAX_DRAFTS_PER_RUN = 5;

/**
 * Hard ceiling on one backfill invocation. The default --limit is 15;
 * --force can push past this up to BACKFILL_ABSOLUTE_MAX. This exists
 * to stop a fat-fingered `--limit 9999` from flooding the editorial
 * channel, billing thousands of Anthropic tokens, and eating Slack rate
 * limits.
 */
export const BACKFILL_SOFT_CAP = 50;
export const BACKFILL_ABSOLUTE_MAX = 200;

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

export interface TriggerResult {
  candidates: number;
  drafted: number;
  failed: number;
}

export interface AnnounceCandidate {
  workos_organization_id: string;
  org_name: string;
  membership_tier: string | null;
  profile_id: string;
  display_name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  offerings: string[] | null;
  primary_brand_domain: string | null;
  brand_manifest: Record<string, unknown> | null;
  last_published_at: Date | null;
}

/**
 * Orgs eligible for a draft. Base filter (always applied):
 *  - `member_profiles.is_public = true` right now
 *  - A brand.json manifest exists for their primary_brand_domain
 *  - `member_profiles.metadata->>'no_announcement'` is not 'true'
 *  - No prior `announcement_draft_posted` or `announcement_skipped` activity
 *
 * Live trigger path (`requireProfilePublished: true`, default) additionally
 * requires a `profile_published` activity row. This is the event the
 * trigger job reacts to.
 *
 * Backfill path (`requireProfilePublished: false`) drops that requirement
 * so orgs that went public before the event emit was added (Workflow A
 * Stage 2) are reachable. Those rows have `is_public = true` today but
 * no activity row to prove when it flipped, so `last_published_at` is
 * NULL and they sort to the end.
 *
 * Ordered by most recent `profile_published` DESC so freshly announce-
 * ready members are never starved by a stale backlog; NULLs last so the
 * backfill path processes newest-known first.
 */
export async function findAnnounceCandidates(
  options: { requireProfilePublished?: boolean } = {},
): Promise<AnnounceCandidate[]> {
  const requirePublished = options.requireProfilePublished ?? true;
  const publishedClause = requirePublished
    ? `AND EXISTS (
          SELECT 1 FROM org_activities
           WHERE organization_id = o.workos_organization_id
             AND activity_type = 'profile_published'
        )`
    : '';
  const result = await query<AnnounceCandidate>(
    `SELECT
        o.workos_organization_id,
        o.name AS org_name,
        o.membership_tier,
        mp.id AS profile_id,
        mp.display_name,
        mp.slug,
        mp.tagline,
        mp.description,
        mp.offerings,
        mp.primary_brand_domain,
        b.brand_manifest,
        (
          SELECT MAX(activity_date)
          FROM org_activities
          WHERE organization_id = o.workos_organization_id
            AND activity_type = 'profile_published'
        ) AS last_published_at
      FROM organizations o
      JOIN member_profiles mp
        ON mp.workos_organization_id = o.workos_organization_id
      JOIN brands b
        ON b.domain = LOWER(mp.primary_brand_domain)
       AND b.brand_manifest IS NOT NULL
      WHERE mp.is_public = true
        AND COALESCE(mp.metadata->>'no_announcement', 'false') <> 'true'
        ${publishedClause}
        AND NOT EXISTS (
          SELECT 1 FROM org_activities
           WHERE organization_id = o.workos_organization_id
             AND activity_type IN ('announcement_draft_posted', 'announcement_skipped')
        )
      ORDER BY last_published_at DESC NULLS LAST, o.created_at DESC`,
  );
  return result.rows;
}

/**
 * Pull a compact list of agents from a brand.json manifest for the drafter
 * prompt. Handles both top-level `agents[]` and nested `brands[].agents[]`.
 */
export function summarizeAgents(
  manifest: Record<string, unknown> | null,
): Array<{ type: string; description?: string | null }> {
  if (!manifest) return [];
  const out: Array<{ type: string; description?: string | null }> = [];
  const pushAgent = (a: unknown) => {
    if (!a || typeof a !== 'object') return;
    const rec = a as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type : null;
    if (!type) return;
    const description = typeof rec.description === 'string' ? rec.description : null;
    out.push({ type, description });
  };

  const top = (manifest as { agents?: unknown }).agents;
  if (Array.isArray(top)) top.forEach(pushAgent);

  const brands = (manifest as { brands?: unknown }).brands;
  if (Array.isArray(brands)) {
    for (const br of brands) {
      if (br && typeof br === 'object') {
        const inner = (br as { agents?: unknown }).agents;
        if (Array.isArray(inner)) inner.forEach(pushAgent);
      }
    }
  }
  return out;
}

/**
 * Neutralize Slack-specific tokens that would otherwise let drafter
 * output ping channels, tag users, or break out of the code fence
 * wrapping the LinkedIn preview.
 *
 *  - `<!channel>` / `<!here>` / `<!everyone>` → plain text
 *  - `<!subteam^Sxxx|@name>` user-group pings → `@group`
 *  - `<@Uxxxxxxx>` and `<@Wxxxxxxx>` user mentions → `@user`
 *  - `<#Cxxxxxxx|name>` / `<#Cxxxxxxx>` channel mentions → `#channel`
 *  - `<https://url|label>` linkified labels → raw `https://url` so a
 *    friendly-looking label can't disguise a hostile URL in the review card
 *
 * When `forFencedBlock` is true (LinkedIn block wraps in triple-backticks),
 * backticks in the content are also replaced so the fence cannot be
 * closed early.
 */
export function sanitizeDraftForSlack(
  text: string,
  options: { forFencedBlock?: boolean } = {},
): string {
  let out = text
    .replace(/<!channel>/gi, '[channel]')
    .replace(/<!here>/gi, '[here]')
    .replace(/<!everyone>/gi, '[everyone]')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|[^>]+)?>/g, '@group')
    .replace(/<@[UW][A-Z0-9]+>/g, '@user')
    .replace(/<#C[A-Z0-9]+(?:\|[^>]+)?>/g, '#channel')
    .replace(/<(https?:\/\/[^|>\s]+)\|[^>]+>/g, '$1');
  if (options.forFencedBlock) {
    out = out.replace(/`/g, "'");
  }
  return out;
}

export function buildReviewBlocks(args: {
  orgName: string;
  workosOrganizationId: string;
  slackText: string;
  linkedinText: string;
  visual: VisualResolution;
  profileSlug: string;
  /** When true, prefixes the header with `[BACKFILL]` so the editorial
   * team can tell a retroactive draft apart from a live-flow one. */
  backfill?: boolean;
}): { text: string; blocks: SlackBlock[] } {
  const profileUrl = `${APP_URL}/members/${args.profileSlug}`;
  const safeSlack = sanitizeDraftForSlack(args.slackText);
  const safeLinkedIn = sanitizeDraftForSlack(args.linkedinText, { forFencedBlock: true });
  const headerText = args.backfill
    ? `[BACKFILL] New member announcement ready: ${args.orgName}`
    : `New member announcement ready: ${args.orgName}`;
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Visual: \`${args.visual.source}\` · Profile: <${profileUrl}|${profileUrl}>`,
        } as unknown as SlackElement,
      ],
    },
    {
      type: 'image',
      image_url: args.visual.url,
      alt_text: args.visual.altText,
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Slack draft*\n${safeSlack}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*LinkedIn draft* (copy-paste)\n\`\`\`${safeLinkedIn}\`\`\``,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve & Post to Slack' },
          action_id: 'announcement_approve_slack',
          value: args.workosOrganizationId,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark posted to LinkedIn' },
          action_id: 'announcement_mark_linkedin',
          value: args.workosOrganizationId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip' },
          action_id: 'announcement_skip',
          value: args.workosOrganizationId,
          style: 'danger',
        },
      ],
    },
  ];

  return {
    text: headerText,
    blocks,
  };
}

async function recordDraftPosted(
  orgId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO org_activities (
        organization_id, activity_type, description, metadata, activity_date
     ) VALUES ($1, 'announcement_draft_posted', $2, $3::jsonb, NOW())`,
    [orgId, 'Announcement draft posted for editorial review', JSON.stringify(metadata)],
  );
}

/**
 * Process a single announce candidate: draft copy, resolve visual, post
 * the review card to the editorial channel, record the idempotency row.
 * Shared by `runAnnouncementTriggerJob` (live flow, hourly cap) and
 * `runBackfillAnnouncements` (one-shot retroactive wave).
 *
 * Returns `true` on success, `false` on any handled failure (network,
 * DB write miss). Unwinds the Slack post if the activity write fails
 * so no orphan review card survives without an idempotency row.
 */
async function processAnnounceCandidate(
  candidate: AnnounceCandidate,
  options: { reviewChannel: string; backfill?: boolean },
): Promise<boolean> {
  const { reviewChannel, backfill = false } = options;
  try {
    const draft = await draftAnnouncement({
      orgName: candidate.org_name,
      membershipTier: candidate.membership_tier,
      displayName: candidate.display_name,
      tagline: candidate.tagline,
      description: candidate.description,
      offerings: candidate.offerings ?? [],
      primaryBrandDomain: candidate.primary_brand_domain,
      agents: summarizeAgents(candidate.brand_manifest),
      profileSlug: candidate.slug,
    });

    const visual = await resolveAnnouncementVisual({
      workosOrganizationId: candidate.workos_organization_id,
      membershipTier: candidate.membership_tier,
      primaryBrandDomain: candidate.primary_brand_domain,
      displayName: candidate.display_name,
    });

    const { text, blocks } = buildReviewBlocks({
      orgName: candidate.org_name,
      workosOrganizationId: candidate.workos_organization_id,
      slackText: draft.slackText,
      linkedinText: draft.linkedinText,
      visual,
      profileSlug: candidate.slug,
      backfill,
    });

    const post = await sendChannelMessage(
      reviewChannel,
      { text, blocks },
      { requirePrivate: true },
    );
    if (!post.ok || !post.ts) {
      logger.error(
        {
          orgId: candidate.workos_organization_id,
          error: post.error,
          skipped: post.skipped,
        },
        'Failed to post announcement draft to editorial channel',
      );
      return false;
    }

    try {
      await recordDraftPosted(candidate.workos_organization_id, {
        review_channel_id: reviewChannel,
        review_message_ts: post.ts,
        slack_text: draft.slackText,
        linkedin_text: draft.linkedinText,
        visual_url: visual.url,
        visual_alt_text: visual.altText,
        visual_source: visual.source,
        org_name: candidate.org_name,
        profile_slug: candidate.slug,
        backfill,
      });
    } catch (recordErr) {
      logger.error(
        { err: recordErr, orgId: candidate.workos_organization_id, ts: post.ts },
        'Activity write failed after posting draft — unwinding Slack message',
      );
      try {
        const undo = await deleteChannelMessage(reviewChannel, post.ts);
        if (!undo.ok) {
          logger.error(
            {
              orgId: candidate.workos_organization_id,
              ts: post.ts,
              undoError: undo.error,
            },
            'CRITICAL: Slack message left without idempotency row — editor will see a duplicate next run',
          );
        }
      } catch (undoErr) {
        logger.error(
          { err: undoErr, orgId: candidate.workos_organization_id, ts: post.ts },
          'CRITICAL: Slack unwind threw — orphan review card, no idempotency row',
        );
      }
      return false;
    }

    logger.info(
      {
        orgId: candidate.workos_organization_id,
        reviewTs: post.ts,
        visualSource: visual.source,
        backfill,
      },
      'Posted announcement draft for editorial review',
    );
    return true;
  } catch (err) {
    logger.error(
      { err, orgId: candidate.workos_organization_id, backfill },
      backfill
        ? 'Failed to draft/post announcement'
        : 'Failed to draft/post announcement — will retry next run',
    );
    return false;
  }
}

/**
 * Resolve the editorial review channel. Prefers the admin-UI DB setting
 * (`editorial_slack_channel`), falls back to the legacy
 * `SLACK_EDITORIAL_REVIEW_CHANNEL` env var for safe rollout. Both null
 * returns `null`; callers should skip the run and log.
 */
export async function resolveEditorialChannel(): Promise<string | null> {
  try {
    const setting = await getEditorialChannel();
    if (setting.channel_id) return setting.channel_id;
  } catch (err) {
    logger.warn({ err }, 'resolveEditorialChannel: DB read failed, falling back to env');
  }
  const env = process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;
  return env && env.trim() ? env.trim() : null;
}

export async function runAnnouncementTriggerJob(): Promise<TriggerResult> {
  const result: TriggerResult = { candidates: 0, drafted: 0, failed: 0 };

  const reviewChannel = await resolveEditorialChannel();
  if (!reviewChannel) {
    logger.warn(
      'Editorial channel not configured — set it at /admin/settings (or SLACK_EDITORIAL_REVIEW_CHANNEL env) — skipping run',
    );
    return result;
  }

  let candidates: AnnounceCandidate[];
  try {
    candidates = await findAnnounceCandidates();
  } catch (err) {
    logger.error({ err }, 'Failed to load announce candidates');
    return result;
  }

  result.candidates = candidates.length;

  for (const candidate of candidates) {
    if (result.drafted >= MAX_DRAFTS_PER_RUN) {
      logger.info(
        { drafted: result.drafted, remaining: candidates.length - result.drafted },
        'Hit per-run draft cap — deferring remainder',
      );
      break;
    }
    const ok = await processAnnounceCandidate(candidate, { reviewChannel });
    if (ok) result.drafted++;
    else result.failed++;
  }

  return result;
}

export interface BackfillOptions {
  /** Editorial channel id to post drafts into. Required. */
  reviewChannel: string;
  /** Hard cap on how many drafts this run will post. Default 15. */
  limit?: number;
  /** When true, print what would happen without posting or writing. */
  dryRun?: boolean;
  /**
   * Bypass the `BACKFILL_SOFT_CAP` ceiling. An operator who really
   * wants to post more than 50 drafts in one run sets this explicitly
   * and accepts the blast-radius implications. Still hard-capped by
   * `BACKFILL_ABSOLUTE_MAX`.
   */
  force?: boolean;
}

export type BackfillPreviewRow = {
  workos_organization_id: string;
  org_name: string;
  membership_tier: string | null;
  primary_brand_domain: string | null;
  last_published_at: Date | null;
};

export interface BackfillResult extends TriggerResult {
  dryRun: boolean;
  /** Cap that was actually applied this run. Useful for log output. */
  effectiveLimit: number;
  /**
   * Rows that would have been drafted (dryRun) or that actually were
   * drafted on the live path. Callers use this to print a per-org
   * summary to stdout and/or to Slack.
   */
  wouldDraft?: BackfillPreviewRow[];
  /** Orgs the live run successfully drafted. Populated only when not dryRun. */
  drafted_orgs?: BackfillPreviewRow[];
  /**
   * Set when another process holds the backfill advisory lock. Caller
   * should surface this to the operator rather than silently skipping.
   */
  lockedOut?: boolean;
}

/**
 * Postgres advisory lock key for the backfill critical section.
 * `pg_try_advisory_lock(bigint)` returns false when another session
 * holds the lock — we refuse to run rather than race. The constant is
 * a stable 64-bit value derived from the string "aao:announcement-backfill".
 */
const BACKFILL_LOCK_ID = 4829347509283745837n;

/**
 * One-shot retroactive announcement wave (Workflow B Stage 4 spec).
 *
 * Queries announce-ready orgs including those without a
 * `profile_published` event (orgs that went public before Workflow A
 * Stage 2 added the event emit), caps at `limit`, and posts each
 * through the same pipeline as the live trigger job with a `[BACKFILL]`
 * header tag. Editorial team spaces them out via the normal approval
 * flow.
 */
function previewRow(c: AnnounceCandidate): BackfillPreviewRow {
  return {
    workos_organization_id: c.workos_organization_id,
    org_name: c.org_name,
    membership_tier: c.membership_tier,
    primary_brand_domain: c.primary_brand_domain,
    last_published_at: c.last_published_at,
  };
}

/**
 * Resolve `options.limit` + `options.force` into an effective cap.
 * Clamps to [1, BACKFILL_ABSOLUTE_MAX] regardless; without `force`,
 * also clamps to BACKFILL_SOFT_CAP. Returns whether the caller's
 * requested limit was shrunk so the CLI can warn the operator.
 */
function resolveBackfillLimit(options: BackfillOptions): {
  effective: number;
  shrunkByCap: boolean;
  shrunkByAbsoluteMax: boolean;
} {
  const requested = Math.max(1, options.limit ?? 15);
  const afterAbsolute = Math.min(requested, BACKFILL_ABSOLUTE_MAX);
  const shrunkByAbsoluteMax = afterAbsolute < requested;
  if (options.force) {
    return {
      effective: afterAbsolute,
      shrunkByCap: false,
      shrunkByAbsoluteMax,
    };
  }
  const afterSoftCap = Math.min(afterAbsolute, BACKFILL_SOFT_CAP);
  return {
    effective: afterSoftCap,
    shrunkByCap: afterSoftCap < requested,
    shrunkByAbsoluteMax,
  };
}

export async function runBackfillAnnouncements(
  options: BackfillOptions,
): Promise<BackfillResult> {
  const { effective: limit } = resolveBackfillLimit(options);
  const dryRun = options.dryRun ?? false;

  const result: BackfillResult = {
    candidates: 0,
    drafted: 0,
    failed: 0,
    dryRun,
    effectiveLimit: limit,
  };

  // Advisory lock: refuse to run if another backfill is already
  // running. Same org set is otherwise visible to both callers, neither
  // holds a lock across the INSERT, and they race. Dry-run also takes
  // the lock so two operators don't both "preview" and then re-run
  // simultaneously.
  const pool = getPool();
  const client = await pool.connect();
  let haveLock = false;
  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS pg_try_advisory_lock',
      [BACKFILL_LOCK_ID.toString()],
    );
    haveLock = lockRes.rows[0]?.pg_try_advisory_lock === true;
    if (!haveLock) {
      logger.warn('backfill: another run is already holding the advisory lock — refusing');
      result.lockedOut = true;
      return result;
    }

    let candidates: AnnounceCandidate[];
    try {
      candidates = await findAnnounceCandidates({ requireProfilePublished: false });
    } catch (err) {
      logger.error({ err }, 'backfill: failed to load announce candidates');
      return result;
    }

    result.candidates = candidates.length;
    const picked = candidates.slice(0, limit);

    if (dryRun) {
      result.wouldDraft = picked.map(previewRow);
      logger.info(
        { totalEligible: candidates.length, limit, wouldDraft: result.wouldDraft.length },
        'backfill dry-run: no posts, no activity writes',
      );
      return result;
    }

    const drafted: BackfillPreviewRow[] = [];
    for (const candidate of picked) {
      const ok = await processAnnounceCandidate(candidate, {
        reviewChannel: options.reviewChannel,
        backfill: true,
      });
      if (ok) {
        result.drafted++;
        drafted.push(previewRow(candidate));
      } else {
        result.failed++;
      }
    }
    result.drafted_orgs = drafted;

    // One summary line in the editorial channel so the reviewers know a
    // retroactive wave just landed. Non-critical — if it fails we log
    // and move on; the cards themselves are the real signal.
    if (result.drafted > 0) {
      try {
        const summary = `📦 Backfill wave posted — ${result.drafted} retroactive draft${result.drafted === 1 ? '' : 's'}${result.failed > 0 ? ` · ${result.failed} failed` : ''} (${candidates.length} eligible, cap ${limit}).`;
        await sendChannelMessage(
          options.reviewChannel,
          { text: summary, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }] },
          { requirePrivate: true },
        );
      } catch (err) {
        logger.warn({ err }, 'backfill: failed to post summary message to editorial channel');
      }
    }

    logger.info(
      { drafted: result.drafted, failed: result.failed, totalEligible: candidates.length, limit },
      'backfill complete',
    );
    return result;
  } finally {
    if (haveLock) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [BACKFILL_LOCK_ID.toString()]);
      } catch (err) {
        logger.warn({ err }, 'backfill: failed to release advisory lock (client will release it)');
      }
    }
    client.release();
  }
}
