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
import { query } from '../../db/client.js';
import { sendChannelMessage, deleteChannelMessage } from '../../slack/client.js';
import { draftAnnouncement } from '../../services/announcement-drafter.js';
import {
  resolveAnnouncementVisual,
  type VisualResolution,
} from '../../services/announcement-visual.js';
import type { SlackBlock, SlackElement } from '../../slack/types.js';

const logger = createLogger('announcement-trigger');

const MAX_DRAFTS_PER_RUN = 5;
const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

export interface TriggerResult {
  candidates: number;
  drafted: number;
  failed: number;
}

interface AnnounceCandidate {
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
 * Orgs eligible for a draft:
 *  - At least one `profile_published` activity recorded
 *  - `member_profiles.is_public = true` right now
 *  - A brand.json manifest exists for their primary_brand_domain
 *  - `member_profiles.metadata->>'no_announcement'` is not 'true'
 *  - No prior `announcement_draft_posted` or `announcement_skipped` activity
 *
 * Ordered by most recent `profile_published` activity first so freshly
 * announce-ready members are not starved by a stale backlog when the
 * per-run cap kicks in.
 */
export async function findAnnounceCandidates(): Promise<AnnounceCandidate[]> {
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
        AND EXISTS (
          SELECT 1 FROM org_activities
           WHERE organization_id = o.workos_organization_id
             AND activity_type = 'profile_published'
        )
        AND NOT EXISTS (
          SELECT 1 FROM org_activities
           WHERE organization_id = o.workos_organization_id
             AND activity_type IN ('announcement_draft_posted', 'announcement_skipped')
        )
      ORDER BY last_published_at DESC NULLS LAST`,
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
}): { text: string; blocks: SlackBlock[] } {
  const profileUrl = `${APP_URL}/members/${args.profileSlug}`;
  const safeSlack = sanitizeDraftForSlack(args.slackText);
  const safeLinkedIn = sanitizeDraftForSlack(args.linkedinText, { forFencedBlock: true });
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `New member announcement ready: ${args.orgName}` },
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
    text: `New member announcement ready: ${args.orgName}`,
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

export async function runAnnouncementTriggerJob(): Promise<TriggerResult> {
  const result: TriggerResult = { candidates: 0, drafted: 0, failed: 0 };

  const reviewChannel = process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;
  if (!reviewChannel) {
    logger.warn('SLACK_EDITORIAL_REVIEW_CHANNEL not configured — skipping run');
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
        result.failed++;
        continue;
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
        result.failed++;
        continue;
      }

      result.drafted++;
      logger.info(
        {
          orgId: candidate.workos_organization_id,
          reviewTs: post.ts,
          visualSource: visual.source,
        },
        'Posted announcement draft for editorial review',
      );
    } catch (err) {
      logger.error(
        { err, orgId: candidate.workos_organization_id },
        'Failed to draft/post announcement — will retry next run',
      );
      result.failed++;
    }
  }

  return result;
}
