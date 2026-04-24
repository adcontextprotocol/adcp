/**
 * Announcement Review Handlers (Workflow B Stage 2)
 *
 * Slack Bolt interactivity handlers for the three buttons on the new-member
 * announcement review card posted by `announcement-trigger.ts`:
 *
 *  - `announcement_approve_slack`  — post `slack_text` + visual to the
 *    configured public announcement channel, then re-render the review
 *    card with a `Mark posted to LinkedIn` follow-up button.
 *  - `announcement_mark_linkedin`  — record that the LinkedIn post has
 *    been made externally, re-render the review card showing both
 *    channels done.
 *  - `announcement_skip`           — record that this announcement was
 *    skipped, re-render the card with no further actions.
 *
 * All three are idempotent and state-driven:
 *
 *  1. Each handler loads the original draft metadata from the
 *     `announcement_draft_posted` activity row and the current state
 *     (`announcement_published` per channel, `announcement_skipped`)
 *     from `org_activities`.
 *  2. It performs at most one side effect:
 *     - approve_slack posts to the public channel (skipped if a prior
 *       `announcement_published` slack row already exists)
 *     - the activity row write is guarded by the same pre-check
 *     - every re-click of any button refreshes the review card to
 *       reflect whatever state the DB says we're in
 *  3. Approve_slack uses the post-then-record ordering from Stage 1.
 *     If the activity write fails after a successful post, we unwind
 *     the Slack post with `chat.delete` so the next click re-posts
 *     cleanly instead of orphaning a public announcement with no
 *     idempotency row.
 *
 * The review card lives in the editorial channel. Its channel ID and
 * message ts come from `body.channel.id` / `body.message.ts`, so this
 * module does not need to know which channel the review happened in.
 */

import { createLogger } from '../../logger.js';
import { query, getPool } from '../../db/client.js';
import { sendChannelMessage, deleteChannelMessage } from '../../slack/client.js';
import { getAnnouncementChannel } from '../../db/system-settings-db.js';
import { sanitizeDraftForSlack } from './announcement-trigger.js';
import { isSafeVisualUrl } from '../../services/announcement-visual.js';
import { isSlackUserAAOAdmin } from '../mcp/admin-tools.js';
import type { SlackBlock, SlackElement } from '../../slack/types.js';

const logger = createLogger('announcement-handlers');

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

// WorkOS org IDs are `org_` followed by uppercase alnum. Reject mixed
// case so a button value of `org_acme` can't point at the row owned by
// `org_ACME` (which is case-sensitive on insert).
const ORG_ID_PATTERN = /^org_[A-Z0-9]+$/;
const SLACK_USER_PATTERN = /^[UW][A-Z0-9]+$/;
const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]+$/;
const MESSAGE_TS_PATTERN = /^\d+\.\d+$/;

// Shared action_id constants — wired to Stage 1 button definitions and
// to boltApp.action() registrations. Renaming any one of these three
// sites silently breaks the flow, so we centralize them.
export const ANNOUNCE_ACTION_IDS = {
  APPROVE_SLACK: 'announcement_approve_slack',
  MARK_LINKEDIN: 'announcement_mark_linkedin',
  SKIP: 'announcement_skip',
} as const;

export interface DraftMetadata {
  review_channel_id: string;
  review_message_ts: string;
  slack_text: string;
  linkedin_text: string;
  visual_url: string;
  visual_alt_text?: string;
  visual_source?: string;
  org_name?: string;
  profile_slug?: string;
}

export interface AnnouncementState {
  slackTs: string | null;
  slackApproverUserId: string | null;
  slackAnnouncementChannelId: string | null;
  linkedinMarkerUserId: string | null;
  linkedinMarkedAt: Date | null;
  skipperUserId: string | null;
  skippedAt: Date | null;
}

interface LoadedDraft {
  draft: DraftMetadata;
  state: AnnouncementState;
}

// Non-generic to let both the pooled `query` wrapper and the per-txn
// `client.query` satisfy the same shape without fighting pg's typed
// overloads. Callsites cast to the expected row type at read time.
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * Internal load used inside a transaction. Callers hold the advisory
 * lock, so a concurrent handler observing the same state will block on
 * the lock rather than racing this read.
 */
async function loadDraftAndStateWith(
  q: QueryFn,
  orgId: string,
): Promise<LoadedDraft | null> {
  const draftRes = (await q(
    `SELECT metadata
       FROM org_activities
      WHERE organization_id = $1
        AND activity_type = 'announcement_draft_posted'
      ORDER BY activity_date DESC
      LIMIT 1`,
    [orgId],
  )) as { rows: Array<{ metadata: DraftMetadata }> };
  if (draftRes.rows.length === 0) return null;
  const draft = draftRes.rows[0].metadata;

  const actRes = (await q(
    `SELECT activity_type, activity_date, metadata
       FROM org_activities
      WHERE organization_id = $1
        AND activity_type IN ('announcement_published', 'announcement_skipped')
      ORDER BY activity_date ASC`,
    [orgId],
  )) as {
    rows: Array<{
      activity_type: string;
      activity_date: Date;
      metadata: Record<string, unknown>;
    }>;
  };

  const state: AnnouncementState = {
    slackTs: null,
    slackApproverUserId: null,
    slackAnnouncementChannelId: null,
    linkedinMarkerUserId: null,
    linkedinMarkedAt: null,
    skipperUserId: null,
    skippedAt: null,
  };

  for (const row of actRes.rows) {
    if (row.activity_type === 'announcement_published') {
      const channel = typeof row.metadata?.channel === 'string' ? row.metadata.channel : null;
      if (channel === 'slack') {
        state.slackTs = typeof row.metadata.slack_ts === 'string' ? row.metadata.slack_ts : null;
        state.slackApproverUserId =
          typeof row.metadata.approver_user_id === 'string' ? row.metadata.approver_user_id : null;
        state.slackAnnouncementChannelId =
          typeof row.metadata.announcement_channel_id === 'string'
            ? row.metadata.announcement_channel_id
            : null;
      } else if (channel === 'linkedin') {
        state.linkedinMarkerUserId =
          typeof row.metadata.marked_by_user_id === 'string'
            ? row.metadata.marked_by_user_id
            : null;
        state.linkedinMarkedAt = row.activity_date;
      }
    } else if (row.activity_type === 'announcement_skipped') {
      state.skipperUserId =
        typeof row.metadata?.skipper_user_id === 'string' ? row.metadata.skipper_user_id : null;
      state.skippedAt = row.activity_date;
    }
  }

  return { draft, state };
}

/**
 * Public wrapper around `loadDraftAndStateWith` that uses the pooled
 * `query` client. Handlers use the transactional form so reads
 * serialize with writes under the advisory lock; this wrapper exists
 * for tests and any future non-mutating caller.
 */
export async function loadDraftAndState(orgId: string): Promise<LoadedDraft | null> {
  return loadDraftAndStateWith(async (sql, params) => {
    const r = await query(sql, params ?? []);
    return { rows: r.rows };
  }, orgId);
}

/**
 * Build the review card blocks from scratch given the draft and current
 * state. Re-rendering the full card on every click keeps the handlers
 * stateless: we never mutate the existing `body.message.blocks`; the DB
 * is the single source of truth.
 */
export function renderReviewCard(args: {
  orgId: string;
  draft: DraftMetadata;
  state: AnnouncementState;
}): { text: string; blocks: SlackBlock[] } {
  const { orgId, draft, state } = args;
  const orgName = draft.org_name ?? 'new member';
  const profileUrl = draft.profile_slug ? `${APP_URL}/members/${draft.profile_slug}` : null;
  const safeSlack = sanitizeDraftForSlack(draft.slack_text);
  const safeLinkedIn = sanitizeDraftForSlack(draft.linkedin_text, { forFencedBlock: true });
  const visualSource = draft.visual_source ?? 'resolved';

  const headerContext: string = profileUrl
    ? `Visual: \`${visualSource}\` · Profile: <${profileUrl}|${profileUrl}>`
    : `Visual: \`${visualSource}\``;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `New member announcement ready: ${orgName}` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: headerContext } as unknown as SlackElement,
      ],
    },
    {
      type: 'image',
      image_url: draft.visual_url,
      alt_text: draft.visual_alt_text ?? `${orgName} announcement visual`,
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*Slack draft*\n${safeSlack}` } },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*LinkedIn draft* (copy-paste)\n\`\`\`${safeLinkedIn}\`\`\`` },
    },
  ];

  // Status line derived from state.
  const statusParts: string[] = [];
  if (state.skipperUserId) {
    statusParts.push(`⊘ Skipped by <@${state.skipperUserId}>`);
  } else {
    statusParts.push(
      state.slackTs
        ? `✓ Slack posted${state.slackApproverUserId ? ` by <@${state.slackApproverUserId}>` : ''}`
        : '⏳ Slack pending',
    );
    statusParts.push(
      state.linkedinMarkerUserId
        ? `✓ LinkedIn posted by <@${state.linkedinMarkerUserId}>`
        : '⏳ LinkedIn pending',
    );
  }
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: statusParts.join(' · ') } as unknown as SlackElement,
    ],
  });

  // Actions derived from state. Terminal states (skipped, or both
  // channels posted) have no actions.
  if (!state.skipperUserId && !(state.slackTs && state.linkedinMarkerUserId)) {
    const actionElements: SlackElement[] = [];
    if (!state.slackTs) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Approve & Post to Slack' },
        action_id: 'announcement_approve_slack',
        value: orgId,
        style: 'primary',
      });
    }
    if (!state.linkedinMarkerUserId) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Mark posted to LinkedIn' },
        action_id: 'announcement_mark_linkedin',
        value: orgId,
      });
    }
    if (!state.slackTs && !state.linkedinMarkerUserId) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Skip' },
        action_id: 'announcement_skip',
        value: orgId,
        style: 'danger',
      });
    }
    if (actionElements.length > 0) {
      blocks.push({ type: 'actions', elements: actionElements });
    }
  }

  return {
    text: `Member announcement review: ${orgName}`,
    blocks,
  };
}

/**
 * Strip bare URLs whose host is not AAO's. `sanitizeDraftForSlack` already
 * unwraps `<url|label>` linkified forms into raw URLs (so labels can't
 * disguise a hostile host in the review card). At public-post time we
 * additionally filter bare URLs: the drafter prompt says the only
 * allowed URL is the member's profile on agenticadvertising.org, and
 * adversarial tagline/agent-description input could still leak a link
 * through the model. Anything not on APP_URL's host gets replaced with
 * `[link removed]`; the permitted host is unchanged.
 */
export function scrubBareUrlsForPublicPost(text: string, appUrl: string): string {
  let allowedHost: string;
  try {
    allowedHost = new URL(appUrl).hostname.toLowerCase();
  } catch {
    return text;
  }
  return text.replace(/https?:\/\/[^\s<>]+/gi, (match) => {
    try {
      const host = new URL(match).hostname.toLowerCase();
      return host === allowedHost ? match : '[link removed]';
    } catch {
      return '[link removed]';
    }
  });
}

/**
 * Build the public announcement payload: sanitized Slack text plus the
 * image. Block Kit `image` blocks render with their own `alt_text`, so
 * the text field is the fallback shown in notifications where blocks
 * don't render.
 *
 * Returns `null` when the stored `visual_url` fails revalidation — the
 * URL was validated when the draft was stored, but we re-check here so
 * a row written by a path that bypasses Stage 1 (manual INSERT, future
 * admin tool, migration) can't flow straight into a public Slack post.
 */
export function buildPublicAnnouncementPayload(draft: DraftMetadata): {
  text: string;
  blocks: SlackBlock[];
} | null {
  if (!isSafeVisualUrl(draft.visual_url)) return null;
  const safeSlack = scrubBareUrlsForPublicPost(
    sanitizeDraftForSlack(draft.slack_text),
    APP_URL,
  );
  const alt = draft.visual_alt_text ?? `${draft.org_name ?? 'New member'} announcement visual`;
  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: safeSlack } },
    { type: 'image', image_url: draft.visual_url, alt_text: alt },
  ];
  return { text: safeSlack, blocks };
}

// Bolt's action body types are a discriminated union that doesn't compose
// cleanly with a narrower handler type. The rest of this file works with
// a shape that has just the fields we need; we accept Bolt's type at the
// registration boundary and let the extraction helper below treat every
// field as unknown until validated.
interface ActionBody {
  actions?: Array<{ value?: unknown }>;
  user?: { id?: unknown };
  channel?: { id?: unknown };
  message?: { ts?: unknown };
}

interface BoltClientLike {
  chat: {
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks: SlackBlock[];
    }) => Promise<unknown>;
    postEphemeral: (args: {
      channel: string;
      user: string;
      text: string;
    }) => Promise<unknown>;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerArgs = any;

/** Extract and validate the fields every handler needs. */
function extractActionContext(body: ActionBody): {
  orgId: string;
  userId: string;
  channelId: string;
  messageTs: string;
} | null {
  const rawOrgId = body.actions?.[0]?.value;
  const rawUserId = body.user?.id;
  const rawChannelId = body.channel?.id;
  const rawTs = body.message?.ts;

  if (
    typeof rawOrgId !== 'string' ||
    typeof rawUserId !== 'string' ||
    typeof rawChannelId !== 'string' ||
    typeof rawTs !== 'string'
  ) {
    return null;
  }
  if (!ORG_ID_PATTERN.test(rawOrgId)) return null;
  if (!SLACK_USER_PATTERN.test(rawUserId)) return null;
  if (!CHANNEL_ID_PATTERN.test(rawChannelId)) return null;
  if (!MESSAGE_TS_PATTERN.test(rawTs)) return null;

  return { orgId: rawOrgId, userId: rawUserId, channelId: rawChannelId, messageTs: rawTs };
}

/**
 * Run `fn` inside a transaction holding a Postgres advisory lock keyed
 * on `(orgId, activity_type)`. Serializes all side effects for a given
 * announcement action — second concurrent click blocks, finds the row
 * written by the first, and falls through the idempotency branch
 * instead of producing a duplicate public post.
 *
 * Lock is released at commit/rollback by Postgres (the `_xact_` suffix
 * on `pg_advisory_xact_lock`). We use `hashtext` so the hash is stable
 * across nodes — no need to manage a lock-id registry.
 */
async function withOrgActionLock<T>(
  orgId: string,
  action: string,
  fn: (q: QueryFn) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `announcement:${orgId}:${action}`,
    ]);
    const result = await fn(async (sql, params) => {
      const r = await client.query(sql, params ?? []);
      return { rows: r.rows };
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function refreshReviewCard(
  client: BoltClientLike,
  channelId: string,
  ts: string,
  orgId: string,
  draft: DraftMetadata,
  state: AnnouncementState,
): Promise<void> {
  const { text, blocks } = renderReviewCard({ orgId, draft, state });
  try {
    await client.chat.update({ channel: channelId, ts, text, blocks });
  } catch (err) {
    logger.warn({ err, orgId, ts }, 'Failed to refresh announcement review card');
  }
}

async function tellUser(
  client: BoltClientLike,
  channelId: string,
  userId: string,
  text: string,
): Promise<void> {
  try {
    await client.chat.postEphemeral({ channel: channelId, user: userId, text });
  } catch (err) {
    logger.warn({ err, channelId, userId }, 'Failed to post ephemeral');
  }
}

/**
 * Admin gate. Anyone with access to the editorial review channel can see
 * the card, but only AAO platform admins are authorized to publish,
 * mark posted, or skip a member announcement.
 */
async function requireAdmin(
  client: BoltClientLike,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const isAdmin = await isSlackUserAAOAdmin(userId);
  if (!isAdmin) {
    await tellUser(
      client,
      channelId,
      userId,
      'Only AAO admins can action member announcements.',
    );
    logger.warn({ userId, channelId }, 'Non-admin attempted to action announcement');
  }
  return isAdmin;
}

type ApproveOutcome =
  | { kind: 'no_draft' }
  | { kind: 'terminal'; draft: DraftMetadata; state: AnnouncementState; notice: string }
  | { kind: 'not_configured' }
  | { kind: 'invalid_visual' }
  | { kind: 'post_failed'; error: string }
  | { kind: 'published'; draft: DraftMetadata; state: AnnouncementState };

/**
 * `Approve & Post to Slack`
 *
 * Post the approved copy + visual to the public announcement channel,
 * then record an `announcement_published` row (channel=slack). The
 * review card is re-rendered to show Slack done and LinkedIn pending.
 *
 * The critical section — state read, existence guard, Slack post, and
 * activity INSERT — runs inside a transaction holding an advisory lock
 * keyed on (orgId, 'approve_slack'). A concurrent second click blocks
 * on the lock, then falls through the "already posted" branch instead
 * of producing a duplicate public announcement.
 */
export async function handleAnnouncementApproveSlack(args: HandlerArgs): Promise<void> {
  const { ack, body, client } = args;
  await ack();

  const ctx = extractActionContext(body);
  if (!ctx) {
    logger.warn({ body }, 'announcement_approve_slack: invalid action body');
    return;
  }
  const { orgId, userId, channelId, messageTs } = ctx;

  if (!(await requireAdmin(client, channelId, userId))) return;

  let outcome: ApproveOutcome;
  try {
    outcome = await withOrgActionLock<ApproveOutcome>(orgId, 'approve_slack', async (q) => {
      const loaded = await loadDraftAndStateWith(q, orgId);
      if (!loaded) return { kind: 'no_draft' };
      const { draft } = loaded;
      const { state } = loaded;

      if (state.skipperUserId) {
        return { kind: 'terminal', draft, state, notice: 'This announcement was already skipped.' };
      }
      if (state.slackTs) {
        return { kind: 'terminal', draft, state, notice: 'Slack announcement was already posted.' };
      }

      const channelSetting = await getAnnouncementChannel();
      if (!channelSetting.channel_id) return { kind: 'not_configured' };

      const payload = buildPublicAnnouncementPayload(draft);
      if (!payload) {
        logger.warn(
          { orgId, visualUrl: draft.visual_url },
          'Rejected announcement post: stored visual_url failed safety check',
        );
        return { kind: 'invalid_visual' };
      }

      const post = await sendChannelMessage(channelSetting.channel_id, payload);
      if (!post.ok || !post.ts) {
        logger.error(
          { orgId, error: post.error, skipped: post.skipped },
          'Failed to post public announcement',
        );
        return { kind: 'post_failed', error: post.error ?? 'unknown error' };
      }

      try {
        await q(
          `INSERT INTO org_activities (
              organization_id, activity_type, description, metadata, activity_date
           ) VALUES ($1, 'announcement_published', $2, $3::jsonb, NOW())`,
          [
            orgId,
            'Announcement published to Slack',
            JSON.stringify({
              channel: 'slack',
              announcement_channel_id: channelSetting.channel_id,
              announcement_channel_name: channelSetting.channel_name,
              slack_ts: post.ts,
              approver_user_id: userId,
            }),
          ],
        );
      } catch (err) {
        logger.error(
          { err, orgId, slackTs: post.ts },
          'Activity write failed after public announcement post — unwinding Slack message',
        );
        let unwindOk = true;
        try {
          const undo = await deleteChannelMessage(channelSetting.channel_id, post.ts);
          if (!undo.ok) {
            unwindOk = false;
            logger.error(
              { orgId, slackTs: post.ts, undoError: undo.error },
              'CRITICAL: Public announcement posted but activity row missing; unwind failed',
            );
          }
        } catch (undoErr) {
          unwindOk = false;
          logger.error(
            { err: undoErr, orgId, slackTs: post.ts },
            'CRITICAL: Public announcement unwind threw — orphan post with no idempotency row',
          );
        }
        // Rethrow so the transaction rolls back. The Slack post is
        // already unwound (or logged as orphaned); the txn rollback
        // just makes sure no half-written row sticks around.
        if (!unwindOk) throw new Error('unwind_failed_with_orphan_post');
        throw err;
      }

      return {
        kind: 'published',
        draft,
        state: {
          ...state,
          slackTs: post.ts,
          slackApproverUserId: userId,
          slackAnnouncementChannelId: channelSetting.channel_id,
        },
      };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg === 'unwind_failed_with_orphan_post') {
      // Orphan post stayed in the announcement channel. Surface this
      // so the admin checks before retrying.
      await tellUser(
        client,
        channelId,
        userId,
        'Posted to Slack but failed to record it and could not undo the post. Please verify `#all-agentic-ads` before retrying.',
      );
      return;
    }
    logger.error({ err, orgId }, 'approve_slack critical section threw');
    await tellUser(
      client,
      channelId,
      userId,
      'Failed to record the announcement. The Slack post was undone; please retry.',
    );
    return;
  }

  switch (outcome.kind) {
    case 'no_draft':
      await tellUser(
        client,
        channelId,
        userId,
        'Could not find the draft for this announcement — it may have been purged.',
      );
      return;
    case 'terminal':
      await refreshReviewCard(client, channelId, messageTs, orgId, outcome.draft, outcome.state);
      await tellUser(client, channelId, userId, outcome.notice);
      return;
    case 'not_configured':
      await tellUser(
        client,
        channelId,
        userId,
        'Public announcement channel is not configured. Set one at /admin/settings/announcement-channel.',
      );
      return;
    case 'invalid_visual':
      await tellUser(
        client,
        channelId,
        userId,
        'This draft\'s visual URL failed a safety check. Re-run the trigger job to generate a fresh draft.',
      );
      return;
    case 'post_failed':
      await tellUser(
        client,
        channelId,
        userId,
        `Slack post failed: ${outcome.error}. No activity was recorded — you can retry.`,
      );
      return;
    case 'published':
      await refreshReviewCard(client, channelId, messageTs, orgId, outcome.draft, outcome.state);
      logger.info(
        { orgId, userId, slackTs: outcome.state.slackTs },
        'Announcement published to Slack',
      );
      return;
  }
}

type SimpleOutcome =
  | { kind: 'no_draft' }
  | { kind: 'refuse'; draft: DraftMetadata; state: AnnouncementState; notice: string }
  | { kind: 'already_done'; draft: DraftMetadata; state: AnnouncementState; notice: string }
  | { kind: 'recorded'; draft: DraftMetadata; state: AnnouncementState };

/**
 * `Mark posted to LinkedIn`
 *
 * Record that an admin has manually posted the draft to LinkedIn.
 * LinkedIn posting is external to AAO — this click closes the loop so
 * the admin backlog view can compute "fully announced".
 */
export async function handleAnnouncementMarkLinkedIn(args: HandlerArgs): Promise<void> {
  const { ack, body, client } = args;
  await ack();

  const ctx = extractActionContext(body);
  if (!ctx) {
    logger.warn({ body }, 'announcement_mark_linkedin: invalid action body');
    return;
  }
  const { orgId, userId, channelId, messageTs } = ctx;

  if (!(await requireAdmin(client, channelId, userId))) return;

  let outcome: SimpleOutcome;
  try {
    outcome = await withOrgActionLock<SimpleOutcome>(orgId, 'mark_linkedin', async (q) => {
      const loaded = await loadDraftAndStateWith(q, orgId);
      if (!loaded) return { kind: 'no_draft' };
      const { draft, state } = loaded;

      if (state.skipperUserId) {
        return {
          kind: 'refuse',
          draft,
          state,
          notice: 'This announcement was already skipped.',
        };
      }
      if (state.linkedinMarkerUserId) {
        return {
          kind: 'already_done',
          draft,
          state,
          notice: 'LinkedIn post was already marked.',
        };
      }

      await q(
        `INSERT INTO org_activities (
            organization_id, activity_type, description, metadata, activity_date
         ) VALUES ($1, 'announcement_published', $2, $3::jsonb, NOW())`,
        [
          orgId,
          'Announcement marked as posted to LinkedIn',
          JSON.stringify({
            channel: 'linkedin',
            marked_by_user_id: userId,
          }),
        ],
      );

      return {
        kind: 'recorded',
        draft,
        state: { ...state, linkedinMarkerUserId: userId, linkedinMarkedAt: new Date() },
      };
    });
  } catch (err) {
    logger.error({ err, orgId, userId }, 'mark_linkedin critical section threw');
    await tellUser(client, channelId, userId, 'Failed to record the LinkedIn post. Please retry.');
    return;
  }

  switch (outcome.kind) {
    case 'no_draft':
      await tellUser(
        client,
        channelId,
        userId,
        'Could not find the draft for this announcement — it may have been purged.',
      );
      return;
    case 'refuse':
    case 'already_done':
      await refreshReviewCard(client, channelId, messageTs, orgId, outcome.draft, outcome.state);
      await tellUser(client, channelId, userId, outcome.notice);
      return;
    case 'recorded':
      await refreshReviewCard(client, channelId, messageTs, orgId, outcome.draft, outcome.state);
      logger.info({ orgId, userId }, 'Announcement marked as posted to LinkedIn');
      return;
  }
}

/**
 * `Skip`
 *
 * Record that this announcement will not be published. The draft stays
 * in the review channel for audit, but no public post or reminders are
 * emitted. Skipping is a terminal state; the announcement-trigger job
 * filters these orgs out on subsequent runs.
 */
export async function handleAnnouncementSkip(args: HandlerArgs): Promise<void> {
  const { ack, body, client } = args;
  await ack();

  const ctx = extractActionContext(body);
  if (!ctx) {
    logger.warn({ body }, 'announcement_skip: invalid action body');
    return;
  }
  const { orgId, userId, channelId, messageTs } = ctx;

  if (!(await requireAdmin(client, channelId, userId))) return;

  let outcome: SimpleOutcome;
  try {
    outcome = await withOrgActionLock<SimpleOutcome>(orgId, 'skip', async (q) => {
      const loaded = await loadDraftAndStateWith(q, orgId);
      if (!loaded) return { kind: 'no_draft' };
      const { draft, state } = loaded;

      if (state.skipperUserId) {
        return {
          kind: 'already_done',
          draft,
          state,
          notice: 'This announcement was already skipped.',
        };
      }
      if (state.slackTs || state.linkedinMarkerUserId) {
        return {
          kind: 'refuse',
          draft,
          state,
          notice:
            'This announcement has already been published on at least one channel and cannot be skipped.',
        };
      }

      await q(
        `INSERT INTO org_activities (
            organization_id, activity_type, description, metadata, activity_date
         ) VALUES ($1, 'announcement_skipped', $2, $3::jsonb, NOW())`,
        [orgId, 'Announcement skipped', JSON.stringify({ skipper_user_id: userId })],
      );

      return {
        kind: 'recorded',
        draft,
        state: { ...state, skipperUserId: userId, skippedAt: new Date() },
      };
    });
  } catch (err) {
    logger.error({ err, orgId, userId }, 'skip critical section threw');
    await tellUser(client, channelId, userId, 'Failed to record the skip. Please retry.');
    return;
  }

  switch (outcome.kind) {
    case 'no_draft':
      await tellUser(
        client,
        channelId,
        userId,
        'Could not find the draft for this announcement — it may have been purged.',
      );
      return;
    case 'refuse':
    case 'already_done':
      await refreshReviewCard(client, channelId, messageTs, orgId, outcome.draft, outcome.state);
      await tellUser(client, channelId, userId, outcome.notice);
      return;
    case 'recorded':
      await refreshReviewCard(client, channelId, messageTs, orgId, outcome.draft, outcome.state);
      logger.info({ orgId, userId }, 'Announcement skipped');
      return;
  }
}
