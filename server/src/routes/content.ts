/**
 * Content routes module
 *
 * Unified content management routes:
 * - Propose content to any collection
 * - View pending content for review
 * - Approve/reject pending content
 * - Get user's content (My Content view)
 */

import { Router } from 'express';
import multer from 'multer';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { contentProposeRateLimiter } from '../middleware/rate-limit.js';
import { getPool } from '../db/client.js';
import { isWebUserAAOAdmin } from '../addie/mcp/admin-tools.js';
import { sendChannelMessage } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';
import { notifyPublishedPost, sendSocialAmplificationDM } from '../notifications/slack.js';
import { getEditorialChannel } from '../db/system-settings-db.js';
import { escapeSlackText } from '../utils/slack-escape.js';
import { computeJourneyStage } from '../addie/services/journey-computation.js';
import { CommunityDatabase } from '../db/community-db.js';
import { createAsset } from '../db/perspective-asset-db.js';
import { fetchPathPageviewCounts } from '../services/posthog-query.js';
import { safeFetch } from '../utils/url-security.js';
import { generateIllustration } from '../services/illustration-generator.js';
import { createIllustration, approveIllustration } from '../db/illustration-db.js';
import { resolveEscalationsForPerspective } from '../db/escalation-db.js';

const logger = createLogger('content-routes');

interface ContentAuthor {
  user_id: string;
  display_name: string;
  display_title?: string;
  display_order?: number;
}

interface ProposeContentRequest {
  title: string;
  subtitle?: string;
  content?: string;
  content_type?: 'article' | 'link';
  external_url?: string;
  external_site_name?: string;
  excerpt?: string;
  category?: string;
  tags?: string[];
  author_title?: string;
  featured_image_url?: string;
  content_origin?: 'official' | 'member' | 'external';
  collection: {
    type?: 'personal' | 'committee';  // Deprecated - kept for backwards compatibility
    committee_slug?: string;
    slug?: string;  // New format - collection slug directly
  };
  authors?: ContentAuthor[];
  status?: 'draft' | 'pending_review' | 'published';
}

/**
 * Fire-and-forget: generate a Gemini cover image for a newly-submitted
 * perspective and auto-approve it so the review dashboard has something
 * to show. Mirrors the digest-publisher pattern: errors are logged but
 * never fail the caller — submission succeeds even if Gemini is down or
 * rate-limited.
 *
 * Caller should skip this when the perspective already has a
 * featured_image_url (the submitter provided their own) or no meaningful
 * title/body to prompt on.
 */
async function generateCoverImageForPendingReview(
  perspectiveId: string,
  title: string,
  category: string | null,
  excerpt: string | null,
): Promise<void> {
  const { imageBuffer, promptUsed, c2pa } = await generateIllustration({
    title,
    category: category ?? 'Perspective',
    excerpt: excerpt ?? undefined,
  });

  const illustration = await createIllustration({
    perspective_id: perspectiveId,
    image_data: imageBuffer,
    prompt_used: promptUsed,
    status: 'generated',
    c2pa_signed_at: c2pa?.signedAt,
    c2pa_manifest_digest: c2pa?.manifestDigest,
  });

  await approveIllustration(illustration.id, perspectiveId);
  logger.info({ perspectiveId }, 'Cover image generated and approved for pending_review content');
}

/**
 * Notify reviewers that content has entered pending_review.
 *
 * Posts to both (a) the working group's Slack channel if one is configured
 * (keeps WG-specific review flows working) and (b) the system-wide editorial
 * review channel if one is configured (central queue for admins and
 * committee leads regardless of WG). Either, both, or neither may exist —
 * that's fine, we just skip what's missing.
 */
async function notifyPendingReview(
  workingGroupId: string,
  perspective: {
    id: string;
    title: string;
    slug: string;
    excerpt: string | null;
    content_type: string;
    content: string | null;
    proposed_at: string;
  },
  authorName: string,
  proposerUserId: string
): Promise<void> {
  const pool = getPool();

  // Fetch the working group, committee leads, and channel config in one
  // round-trip so we can enrich the message with lead names. The leads
  // query only surfaces WorkOS-linked users — slack-only leads (leaders
  // added by Slack ID before mapping) won't appear in the `*Leads:*` line.
  // That matches the current data-integrity requirement; a reviewer seeing
  // a missing leads line just means the committee has unmapped leads.
  const [wgResult, leadersResult, editorialChannel] = await Promise.all([
    pool.query(
      `SELECT name, slack_channel_id FROM working_groups WHERE id = $1`,
      [workingGroupId]
    ),
    pool.query(
      `SELECT u.first_name, u.last_name, u.email
         FROM working_group_leaders wgl
         LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
         LEFT JOIN users u ON u.workos_user_id = COALESCE(sm.workos_user_id, wgl.user_id)
         WHERE wgl.working_group_id = $1
           AND u.workos_user_id IS NOT NULL
         LIMIT 10`,
      [workingGroupId]
    ),
    getEditorialChannel(),
  ]);

  if (wgResult.rows.length === 0) {
    logger.warn({ workingGroupId }, 'Working group not found for pending-review notification');
    return;
  }

  const { name: wgName, slack_channel_id: wgChannelId } = wgResult.rows[0];
  const editorialChannelId = editorialChannel.channel_id;

  if (!wgChannelId && !editorialChannelId) {
    logger.debug({ workingGroupId }, 'No Slack channels configured for pending-review notification');
    return;
  }

  const leadNames: string[] = leadersResult.rows
    .map(r => (r.first_name && r.last_name ? `${r.first_name} ${r.last_name}` : r.email?.split('@')[0] || null))
    .filter((n): n is string => !!n);

  const safeTitle = escapeSlackText(perspective.title, 180);
  const safeAuthor = escapeSlackText(authorName, 80);
  const safeWg = escapeSlackText(wgName, 80);
  const safeExcerpt = perspective.excerpt ? escapeSlackText(perspective.excerpt, 240) : null;
  const leadLine = leadNames.length > 0
    ? `*Leads:* ${leadNames.map(n => escapeSlackText(n, 60)).join(', ')}`
    : '';
  const excerptLine = safeExcerpt ? `\n\n> ${safeExcerpt}` : '';
  const reviewUrl = `https://agenticadvertising.org/dashboard/content?status=pending_review&id=${encodeURIComponent(perspective.id)}`;
  const typeLabel = perspective.content_type === 'link' ? 'Link' : 'Article';

  // Reviewer triage fields: word count, reading time, submission age,
  // source (Addie vs direct). Gives reviewers enough to decide whether
  // to open the draft without clicking through.
  const wordCount = perspective.content
    ? perspective.content.split(/\s+/).filter(Boolean).length
    : 0;
  const readingMin = Math.max(1, Math.round(wordCount / 200));
  const proposedAtUnix = Math.floor(new Date(perspective.proposed_at).getTime() / 1000);
  const submittedLine = `Submitted <!date^${proposedAtUnix}^{date_short_pretty} at {time}|${perspective.proposed_at}>`;
  const source = proposerUserId === 'system:addie' || proposerUserId?.startsWith('system:')
    ? 'drafted with Addie'
    : 'direct submission';
  const triageLine = perspective.content_type === 'article' && wordCount > 0
    ? `${wordCount.toLocaleString()} words • ~${readingMin} min read • ${submittedLine} • ${source}`
    : `${submittedLine} • ${source}`;

  const headerLine = `📝 *New ${typeLabel.toLowerCase()} for review — ${safeWg}*`;
  const titleLine = `*${safeTitle}* by ${safeAuthor}`;

  const messageBlocks = [
    `${headerLine}\n${titleLine}\n${triageLine}`,
    leadLine,
    excerptLine.trimStart(),
  ].filter(Boolean).join('\n');

  const message: SlackBlockMessage = {
    text: `${typeLabel} pending review: "${safeTitle}" by ${safeAuthor}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: messageBlocks,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Review draft', emoji: true },
            url: reviewUrl,
            action_id: 'review_content',
            style: 'primary',
          },
        ],
      },
    ],
  };

  const targets: Array<{ channelId: string; label: string }> = [];
  if (wgChannelId) targets.push({ channelId: wgChannelId, label: 'working group' });
  // Avoid double-posting if WG and editorial channels are the same
  if (editorialChannelId && editorialChannelId !== wgChannelId) {
    targets.push({ channelId: editorialChannelId, label: 'editorial' });
  }

  const results = await Promise.all(targets.map(async ({ channelId, label }) => {
    try {
      await sendChannelMessage(channelId, message);
      logger.info(
        { workingGroupId, perspectiveId: perspective.id, channelId, target: label },
        'Sent pending content notification'
      );
      return true;
    } catch (error) {
      logger.error(
        { error, workingGroupId, perspectiveId: perspective.id, channelId, target: label },
        'Failed to send pending content notification'
      );
      return false;
    }
  }));

  // Surface the case where every configured target failed. A single
  // failure is already logged per-target; the additional log fires only
  // when the queue is effectively silent despite a channel being
  // configured — ops can alert on this.
  if (results.length > 0 && results.every(r => !r)) {
    logger.error(
      { workingGroupId, perspectiveId: perspective.id, targetCount: targets.length },
      'All pending-review notification targets failed — reviewers will not be paged'
    );
  }
}

/**
 * Check if user is a committee lead (handles both WorkOS and Slack user IDs)
 */
async function isCommitteeLead(committeeId: string, userId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT 1 FROM working_group_leaders wgl
     LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
     WHERE wgl.working_group_id = $1 AND (wgl.user_id = $2 OR sm.workos_user_id = $2)`,
    [committeeId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Get user info for author display
 */
async function getUserInfo(userId: string): Promise<{ name: string } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT first_name, last_name, email FROM users WHERE workos_user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  const user = result.rows[0];
  const name = user.first_name && user.last_name
    ? `${user.first_name} ${user.last_name}`
    : user.email?.split('@')[0] || 'Unknown';
  return { name };
}

/**
 * User context for direct function calls (from Addie or other internal services)
 */
export interface ContentUser {
  id: string;
  email?: string;
}

/**
 * Result from proposeContentForUser
 */
export interface ProposeContentResult {
  success: boolean;
  id?: string;
  slug?: string;
  status?: 'published' | 'pending_review' | 'draft';
  message?: string;
  error?: string;
}

/**
 * Propose content to a collection - direct function call (no HTTP required).
 * Use this from internal services like Addie to bypass HTTP authentication.
 */
export async function proposeContentForUser(
  user: ContentUser,
  request: ProposeContentRequest
): Promise<ProposeContentResult> {
  const {
    title,
    subtitle,
    content,
    content_type = 'article',
    external_url,
    external_site_name,
    excerpt,
    category,
    tags = [],
    author_title: requestAuthorTitle,
    featured_image_url,
    content_origin = 'member',
    collection,
    authors,
    status: requestedStatus,
  } = request;

  // Validate required fields
  if (!title) {
    return { success: false, error: 'title is required' };
  }

  // Support both old format (collection.type + committee_slug) and new format (just committee_slug)
  const committeeSlug = collection?.committee_slug || collection?.slug;
  if (!committeeSlug) {
    return { success: false, error: 'collection.committee_slug or collection.slug is required' };
  }

  // Validate content_type requirements
  if (content_type === 'link' && !external_url) {
    return { success: false, error: 'external_url is required for link type content' };
  }

  if (content_type === 'article' && !content) {
    return { success: false, error: 'content is required for article type content' };
  }

  const pool = getPool();

  // Resolve the collection (working group)
  const committeeResult = await pool.query(
    `SELECT id, name, accepts_public_submissions, slack_channel_id FROM working_groups WHERE slug = $1`,
    [committeeSlug]
  );

  if (committeeResult.rows.length === 0) {
    logger.warn({ committeeSlug, userId: user.id }, 'Content proposal failed: collection not found');
    return { success: false, error: `No collection found with slug: ${committeeSlug}` };
  }

  const committee = committeeResult.rows[0];
  const committeeId = committee.id as string;
  const committeeName = committee.name as string;
  const committeeSlackChannelId = committee.slack_channel_id as string | null;
  const acceptsPublicSubmissions = committee.accepts_public_submissions;

  // Check if user can submit to this collection
  const userIsLead = await isCommitteeLead(committeeId, user.id);
  const userIsAdmin = await isWebUserAAOAdmin(user.id);

  // For non-public collections, user must be a member
  if (!acceptsPublicSubmissions && !userIsLead && !userIsAdmin) {
    const membershipResult = await pool.query(
      `SELECT 1 FROM working_group_memberships WHERE working_group_id = $1 AND workos_user_id = $2`,
      [committeeId, user.id]
    );
    if (membershipResult.rows.length === 0) {
      logger.warn({ committeeSlug, userId: user.id }, 'Content proposal failed: user not a member');
      return { success: false, error: 'You must be a member of this committee to submit content' };
    }
  }

  // Only admins can mark content as official AAO content
  const effectiveOrigin = (content_origin === 'official' && !userIsAdmin) ? 'member' : content_origin;

  // Determine if user can publish directly (leads and admins only)
  const canPublishDirectly = userIsLead || userIsAdmin;

  // Generate slug from title
  const baseSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 100);
  const slug = `${baseSlug}-${Date.now().toString(36)}`;

  // Determine initial status. Default is always `pending_review` — callers must
  // opt in to publishing by passing an explicit `status`. Leads and admins can
  // choose draft/pending_review/published; members can choose draft or
  // pending_review (a published request is demoted).
  //
  // The explicit-opt-in default prevents programmatic callers (Addie, Share-a-
  // Link, scripts) from silently bypassing editorial review when the caller is
  // incidentally a lead or admin.
  const status: 'draft' | 'pending_review' | 'published' = canPublishDirectly
    ? (requestedStatus ?? 'pending_review')
    : (requestedStatus === 'draft' ? 'draft' : 'pending_review');

  if (requestedStatus === undefined && status === 'pending_review' && canPublishDirectly) {
    logger.info({
      userId: user.id,
      committeeSlug,
      contentOrigin: effectiveOrigin,
    }, 'Content defaulting to pending_review (no explicit status requested)');
  }
  const publishedAt = status === 'published' ? new Date().toISOString() : null;
  const proposedAt = new Date().toISOString();

  // Get author info for display
  const userInfo = await getUserInfo(user.id);
  const authorName = userInfo?.name || user.email?.split('@')[0] || 'Unknown';

  // Insert the content
  const result = await pool.query(
    `INSERT INTO perspectives (
      slug, content_type, title, subtitle, content, excerpt,
      external_url, external_site_name, category, tags,
      author_name, author_title, author_user_id,
      featured_image_url, content_origin,
      proposer_user_id, proposed_at,
      working_group_id, status, published_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    RETURNING *`,
    [
      slug, content_type, title, subtitle || null, content, excerpt,
      external_url, external_site_name, category, tags,
      authorName, requestAuthorTitle || null, user.id,
      featured_image_url || null, effectiveOrigin,
      user.id, proposedAt,
      committeeId, status, publishedAt,
    ]
  );

  const perspective = result.rows[0];

  // Fire-and-forget journey recomputation (content contribution is a milestone)
  const userOrgResult = await pool.query(
    `SELECT workos_organization_id FROM organization_memberships WHERE workos_user_id = $1 LIMIT 1`,
    [user.id]
  );
  if (userOrgResult.rows[0]) {
    computeJourneyStage(userOrgResult.rows[0].workos_organization_id, 'content_contribution', `perspective:${perspective.id}`)
      .catch((err) => { logger.error({ err, perspectiveId: perspective.id }, 'Journey stage computation failed'); });
  }

  // Create content_authors records
  const authorsToCreate = authors && authors.length > 0
    ? authors
    : [{ user_id: user.id, display_name: authorName, display_title: null, display_order: 0 }];

  for (const author of authorsToCreate) {
    await pool.query(
      `INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (perspective_id, user_id) DO NOTHING`,
      [perspective.id, author.user_id, author.display_name, author.display_title, author.display_order || 0]
    );
  }

  logger.info({
    perspectiveId: perspective.id,
    userId: user.id,
    title,
    status,
    committeeSlug,
  }, 'Content proposed via direct function call');

  // Notify working group and editorial reviewers if content needs review
  if (status === 'pending_review') {
    notifyPendingReview(
      committeeId,
      {
        id: perspective.id,
        title: perspective.title,
        slug: perspective.slug,
        excerpt: perspective.excerpt ?? null,
        content_type: perspective.content_type,
        content: perspective.content ?? null,
        proposed_at: perspective.proposed_at,
      },
      authorName,
      user.id
    ).catch(err => {
      logger.error({ err, perspectiveId: perspective.id, committeeId, authorName }, 'Failed to send content notification');
    });

    // Auto-generate a cover image unless the submitter already provided
    // one. Fire-and-forget: errors never block the submission response.
    // Only meaningful for article-type perspectives — link shares use
    // the external site's og:image.
    const shouldAutoGenerate = content_type === 'article'
      && !featured_image_url
      && !!perspective.title;
    if (shouldAutoGenerate) {
      generateCoverImageForPendingReview(
        perspective.id,
        perspective.title,
        perspective.category ?? null,
        perspective.excerpt ?? null,
      ).catch(err => {
        logger.warn(
          { err, perspectiveId: perspective.id },
          'Auto cover-image generation failed — post will enter review without an image'
        );
      });
    }
  } else if (status === 'published') {
    notifyPublishedPost({
      slackChannelId: committeeSlackChannelId ?? undefined,
      workingGroupName: committeeName,
      workingGroupSlug: committeeSlug,
      postTitle: title,
      postSlug: perspective.slug,
      authorName,
      contentType: content_type,
      excerpt: excerpt || undefined,
      externalUrl: external_url || undefined,
      category: category || undefined,
      isMembersOnly: false,
    }).catch(err => {
      logger.warn({ err }, 'Failed to send Slack channel notification for proposed content');
    });

    // Award community points + check badges (fire-and-forget)
    const communityDb = new CommunityDatabase();
    communityDb.awardPoints(user.id, 'content_published', 50, perspective.id, 'perspective').catch(err => {
      logger.error({ err, userId: user.id }, 'Failed to award content publishing points');
    });
    communityDb.checkAndAwardBadges(user.id, 'content').catch(err => {
      logger.error({ err, userId: user.id }, 'Failed to check content badges');
    });
  }

  const message = status === 'published'
    ? 'Content published successfully'
    : status === 'draft'
      ? 'Draft saved'
      : 'Content submitted for review. A committee lead or admin will review it soon.';

  return {
    success: true,
    id: perspective.id,
    slug: perspective.slug,
    status: perspective.status,
    message,
  };
}

/**
 * Pending content item as returned to reviewers.
 */
export interface PendingContentItem {
  id: string;
  title: string;
  subtitle: string | null;
  slug: string;
  excerpt: string | null;
  content: string | null;
  content_type: string;
  external_url: string | null;
  external_site_name: string | null;
  proposer: { id: string; name: string };
  proposed_at: string;
  collection: {
    type: 'committee' | 'personal';
    committee_name: string | null;
    committee_slug: string | null;
  };
  authors: Array<{ user_id: string; display_name: string }>;
}

export interface PendingContentResult {
  items: PendingContentItem[];
  summary: {
    total: number;
    by_collection: Record<string, number>;
  };
}

/**
 * List pending content the user is permitted to review - direct function call (no HTTP required).
 * Admins see all pending content; committee leads see only their committees' pending items.
 */
export async function listPendingContentForUser(
  user: ContentUser,
  opts: { committeeSlug?: string } = {}
): Promise<PendingContentResult> {
  const pool = getPool();
  const { committeeSlug } = opts;

  // Committees this user leads (direct workos_user_id or via slack mapping)
  const leaderResult = await pool.query(
    `SELECT wg.id
     FROM working_group_leaders wgl
     LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
     JOIN working_groups wg ON wg.id = wgl.working_group_id
     WHERE wgl.user_id = $1 OR sm.workos_user_id = $1`,
    [user.id]
  );
  const ledCommitteeIds = leaderResult.rows.map(c => c.id);
  const userIsAdmin = await isWebUserAAOAdmin(user.id);

  if (!userIsAdmin && ledCommitteeIds.length === 0) {
    return { items: [], summary: { total: 0, by_collection: {} } };
  }

  let query = `
    SELECT
      p.id, p.title, p.subtitle, p.excerpt, p.content, p.slug, p.content_type,
      p.external_url, p.external_site_name,
      p.proposer_user_id, p.proposed_at, p.working_group_id,
      wg.name as committee_name, wg.slug as committee_slug,
      u.first_name, u.last_name, u.email as proposer_email,
      (SELECT json_agg(json_build_object(
        'user_id', ca.user_id,
        'display_name', ca.display_name
      ) ORDER BY ca.display_order)
      FROM content_authors ca WHERE ca.perspective_id = p.id) as authors
    FROM perspectives p
    LEFT JOIN working_groups wg ON wg.id = p.working_group_id
    LEFT JOIN users u ON u.workos_user_id = p.proposer_user_id
    WHERE p.status = 'pending_review'
  `;
  const params: (string | string[])[] = [];

  if (!userIsAdmin) {
    params.push(ledCommitteeIds);
    query += ` AND p.working_group_id = ANY($${params.length})`;
  }
  if (committeeSlug) {
    params.push(committeeSlug);
    query += ` AND wg.slug = $${params.length}`;
  }
  query += ` ORDER BY p.proposed_at ASC`;

  const result = await pool.query(query, params);

  const items: PendingContentItem[] = result.rows.map(row => ({
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    slug: row.slug,
    excerpt: row.excerpt,
    content: row.content,
    content_type: row.content_type,
    external_url: row.external_url,
    external_site_name: row.external_site_name,
    proposer: {
      id: row.proposer_user_id,
      name: row.first_name && row.last_name
        ? `${row.first_name} ${row.last_name}`
        : row.proposer_email?.split('@')[0] || 'Unknown',
    },
    proposed_at: row.proposed_at,
    collection: {
      type: row.working_group_id ? 'committee' : 'personal',
      committee_name: row.committee_name,
      committee_slug: row.committee_slug,
    },
    authors: row.authors || [],
  }));

  const byCollection: Record<string, number> = {};
  for (const item of items) {
    const key = item.collection.committee_slug || 'personal';
    byCollection[key] = (byCollection[key] || 0) + 1;
  }

  return { items, summary: { total: items.length, by_collection: byCollection } };
}

export type ContentReviewError =
  | 'not_found'
  | 'invalid_status'
  | 'permission_denied'
  | 'missing_reason';

export interface ContentReviewResult {
  success: boolean;
  status?: 'published' | 'draft' | 'rejected';
  message?: string;
  error?: ContentReviewError;
  error_message?: string;
}

/**
 * Approve pending content - direct function call (no HTTP required).
 */
export async function approveContentForUser(
  user: ContentUser,
  contentId: string,
  opts: { publishImmediately?: boolean } = {}
): Promise<ContentReviewResult> {
  const publishImmediately = opts.publishImmediately ?? true;
  const pool = getPool();

  const contentResult = await pool.query(
    `SELECT p.*, wg.slug as committee_slug, wg.name as committee_name, wg.slack_channel_id
     FROM perspectives p
     LEFT JOIN working_groups wg ON wg.id = p.working_group_id
     WHERE p.id = $1`,
    [contentId]
  );

  if (contentResult.rows.length === 0) {
    return { success: false, error: 'not_found', error_message: `No content found with id: ${contentId}` };
  }

  const content = contentResult.rows[0];

  if (content.status !== 'pending_review') {
    return {
      success: false,
      error: 'invalid_status',
      error_message: `Content is not pending review (current status: ${content.status})`,
    };
  }

  const userIsAdmin = await isWebUserAAOAdmin(user.id);
  const userIsLead = content.working_group_id
    ? await isCommitteeLead(content.working_group_id, user.id)
    : false;

  if (!userIsAdmin && !userIsLead) {
    return {
      success: false,
      error: 'permission_denied',
      error_message: 'You do not have permission to approve this content',
    };
  }

  const newStatus: 'published' | 'draft' = publishImmediately ? 'published' : 'draft';
  const publishedAt = publishImmediately ? new Date().toISOString() : null;

  await pool.query(
    `UPDATE perspectives
     SET status = $1, published_at = $2,
         reviewed_by_user_id = $3, reviewed_at = NOW()
     WHERE id = $4`,
    [newStatus, publishedAt, user.id, contentId]
  );

  logger.info({
    contentId,
    reviewerId: user.id,
    newStatus,
    committeeSlug: content.committee_slug,
  }, 'Content approved');

  if (newStatus === 'published' && content.committee_slug) {
    notifyPublishedPost({
      slackChannelId: content.slack_channel_id ?? undefined,
      workingGroupName: content.committee_name,
      workingGroupSlug: content.committee_slug,
      postTitle: content.title,
      postSlug: content.slug,
      authorName: content.author_name || 'Unknown',
      contentType: content.content_type || 'article',
      excerpt: content.excerpt || undefined,
      externalUrl: content.external_url || undefined,
      category: content.category || undefined,
      isMembersOnly: content.is_members_only || false,
    }).catch(err => {
      logger.warn({ err }, 'Failed to send Slack channel notification for approved content');
    });

    if (content.proposer_user_id) {
      sendSocialAmplificationDM({
        proposerUserId: content.proposer_user_id,
        title: content.title,
        excerpt: content.excerpt || undefined,
        subtitle: content.subtitle || undefined,
        workingGroupSlug: content.committee_slug,
        postSlug: content.slug,
        contentType: content.content_type || 'article',
        isMembersOnly: content.is_members_only || false,
      }).catch(err => {
        logger.warn({ err }, 'Failed to send social amplification DM for approved content');
      });
    }
  }

  // Auto-resolve any open escalations Addie filed about this specific
  // perspective (escalate_to_admin passes perspective_id when linking
  // an escalation to a draft). Fire-and-forget — approval succeeds
  // even if the escalation resolve query errors. See #2702.
  resolveEscalationsForPerspective(
    contentId,
    user.id,
    `Auto-resolved: content approved by reviewer`
  ).then(ids => {
    if (ids.length > 0) {
      logger.info(
        { contentId, reviewerId: user.id, resolvedEscalationIds: ids },
        'Auto-resolved escalations linked to approved content'
      );
    }
  }).catch(err => {
    logger.warn({ err, contentId }, 'Failed to auto-resolve linked escalations');
  });

  return {
    success: true,
    status: newStatus,
    message: publishImmediately
      ? 'Content approved and published'
      : 'Content approved and saved as draft',
  };
}

/**
 * Reject pending content - direct function call (no HTTP required).
 */
export async function rejectContentForUser(
  user: ContentUser,
  contentId: string,
  reason: string
): Promise<ContentReviewResult> {
  if (!reason) {
    return {
      success: false,
      error: 'missing_reason',
      error_message: 'A reason is required when rejecting content',
    };
  }

  const pool = getPool();

  const contentResult = await pool.query(
    `SELECT p.*, wg.slug as committee_slug
     FROM perspectives p
     LEFT JOIN working_groups wg ON wg.id = p.working_group_id
     WHERE p.id = $1`,
    [contentId]
  );

  if (contentResult.rows.length === 0) {
    return { success: false, error: 'not_found', error_message: `No content found with id: ${contentId}` };
  }

  const content = contentResult.rows[0];

  if (content.status !== 'pending_review') {
    return {
      success: false,
      error: 'invalid_status',
      error_message: `Content is not pending review (current status: ${content.status})`,
    };
  }

  const userIsAdmin = await isWebUserAAOAdmin(user.id);
  const userIsLead = content.working_group_id
    ? await isCommitteeLead(content.working_group_id, user.id)
    : false;

  if (!userIsAdmin && !userIsLead) {
    return {
      success: false,
      error: 'permission_denied',
      error_message: 'You do not have permission to reject this content',
    };
  }

  await pool.query(
    `UPDATE perspectives
     SET status = 'rejected', rejection_reason = $1,
         reviewed_by_user_id = $2, reviewed_at = NOW()
     WHERE id = $3`,
    [reason, user.id, contentId]
  );

  logger.info({
    contentId,
    reviewerId: user.id,
    reason,
    committeeSlug: content.committee_slug,
  }, 'Content rejected');

  return { success: true, status: 'rejected', message: 'Content rejected' };
}

/**
 * Create content routes
 * Returns a router to be mounted at /api/content
 */
export function createContentRouter(): Router {
  const router = Router();

  // GET /api/content/collections - Get available collections for content submission
  router.get('/collections', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const pool = getPool();

      // Get public collections (anyone can submit)
      const publicResult = await pool.query(
        `SELECT id, slug, name, description
         FROM working_groups
         WHERE accepts_public_submissions = TRUE
         ORDER BY name`
      );

      // Get committees user is a member of (non-public ones)
      // Join with slack_user_mappings to handle users who were added as leader via Slack ID
      const memberResult = await pool.query(
        `SELECT wg.id, wg.slug, wg.name, wg.description,
                EXISTS(
                  SELECT 1 FROM working_group_leaders wgl
                  LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
                  WHERE wgl.working_group_id = wg.id AND (wgl.user_id = $1 OR sm.workos_user_id = $1)
                ) as is_leader
         FROM working_group_memberships wgm
         JOIN working_groups wg ON wg.id = wgm.working_group_id
         WHERE wgm.workos_user_id = $1
           AND wg.accepts_public_submissions = FALSE
         ORDER BY wg.name`,
        [user.id]
      );

      const collections = [
        ...publicResult.rows.map(row => ({
          slug: row.slug,
          name: row.name,
          description: row.description,
          type: 'public' as const,
          can_publish_directly: false, // Public collections always require approval
        })),
        ...memberResult.rows.map(row => ({
          slug: row.slug,
          name: row.name,
          description: row.description,
          type: 'committee' as const,
          can_publish_directly: row.is_leader,
        })),
      ];

      res.json({ collections });
    } catch (error) {
      logger.error({ err: error }, 'GET /api/content/collections error');
      res.status(500).json({
        error: 'Failed to get collections',
      });
    }
  });

  // POST /api/content/propose - Submit content to any collection
  router.post('/propose', requireAuth, contentProposeRateLimiter, async (req, res) => {
    try {
      const user = req.user!;
      const result = await proposeContentForUser(
        { id: user.id, email: user.email },
        req.body as ProposeContentRequest
      );

      if (!result.success) {
        // Map errors to appropriate HTTP status codes
        const status = result.error?.includes('not found') ? 404
                     : result.error?.includes('must be a member') ? 403
                     : 400;
        return res.status(status).json({
          error: status === 404 ? 'Collection not found'
               : status === 403 ? 'Not a member'
               : 'Validation error',
          message: result.error,
        });
      }

      res.status(201).json({
        id: result.id,
        slug: result.slug,
        status: result.status,
        message: result.message,
      });
    } catch (error) {
      logger.error({ err: error }, 'POST /api/content/propose error');
      res.status(500).json({
        error: 'Failed to propose content',
      });
    }
  });

  // GET /api/content/pending - List pending content user can review
  router.get('/pending', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const committeeSlug = req.query.committee_slug as string | undefined;
      const result = await listPendingContentForUser(
        { id: user.id, email: user.email },
        { committeeSlug }
      );
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'GET /api/content/pending error');
      res.status(500).json({
        error: 'Failed to get pending content',
      });
    }
  });

  // POST /api/content/:id/approve - Approve pending content
  router.post('/:id/approve', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const { publish_immediately = true } = req.body;

      const result = await approveContentForUser(
        { id: user.id, email: user.email },
        id,
        { publishImmediately: publish_immediately }
      );

      if (!result.success) {
        const httpStatus = result.error === 'not_found' ? 404
                         : result.error === 'permission_denied' ? 403
                         : 400;
        return res.status(httpStatus).json({
          error: result.error === 'not_found' ? 'Content not found'
               : result.error === 'permission_denied' ? 'Permission denied'
               : 'Invalid status',
          message: result.error_message,
        });
      }

      res.json({
        success: true,
        status: result.status,
        message: result.message,
      });
    } catch (error) {
      logger.error({ err: error }, 'POST /api/content/:id/approve error');
      res.status(500).json({
        error: 'Failed to approve content',
      });
    }
  });

  // POST /api/content/fetch-url - Fetch URL metadata for auto-fill
  router.post('/fetch-url', requireAuth, async (req, res) => {
    try {
      const { url } = req.body;

      if (!url) {
        return res.status(400).json({
          error: 'URL required',
          message: 'Please provide a URL to fetch',
        });
      }

      // SSRF-safe fetch: validates URL, DNS resolution, and all redirect hops
      const response = await safeFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AgenticAdvertising/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        maxRedirects: 5,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch URL: ${response.status}`);
      }

      const html = await response.text();

      // Extract metadata from HTML
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
      const ogSiteMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);

      // Decode HTML entities helper
      const decodeHtmlEntities = (text: string): string => {
        // &amp; must be decoded last to avoid double-decoding (e.g. &amp;lt; -> &lt; -> <)
        return text
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
          .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/&amp;/g, '&');
      };

      // Determine title (prefer og:title, then <title>)
      let title = ogTitleMatch?.[1] || titleMatch?.[1] || '';
      title = decodeHtmlEntities(title.trim());

      // Determine description (prefer og:description, then meta description)
      let excerpt = ogDescMatch?.[1] || descMatch?.[1] || '';
      excerpt = decodeHtmlEntities(excerpt.trim());

      // Site name from og:site_name or parse from URL
      let site_name = ogSiteMatch?.[1] || '';
      if (!site_name) {
        try {
          const parsedUrl = new URL(url);
          site_name = parsedUrl.hostname.replace(/www\./g, '');
          // Capitalize first letter
          site_name = site_name.charAt(0).toUpperCase() + site_name.slice(1);
        } catch {
          // ignore URL parse errors
        }
      }
      site_name = decodeHtmlEntities(site_name);

      res.json({
        title,
        excerpt,
        site_name,
      });
    } catch (error) {
      logger.error({ err: error }, 'POST /api/content/fetch-url error');
      res.status(500).json({
        error: 'Failed to fetch URL',
      });
    }
  });

  // POST /api/content/:id/reject - Reject pending content
  router.post('/:id/reject', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const { reason } = req.body;

      const result = await rejectContentForUser(
        { id: user.id, email: user.email },
        id,
        reason
      );

      if (!result.success) {
        const httpStatus = result.error === 'not_found' ? 404
                         : result.error === 'permission_denied' ? 403
                         : 400;
        return res.status(httpStatus).json({
          error: result.error === 'not_found' ? 'Content not found'
               : result.error === 'permission_denied' ? 'Permission denied'
               : result.error === 'missing_reason' ? 'Missing reason'
               : 'Invalid status',
          message: result.error_message,
        });
      }

      res.json({
        success: true,
        status: result.status,
        message: result.message,
      });
    } catch (error) {
      logger.error({ err: error }, 'POST /api/content/:id/reject error');
      res.status(500).json({
        error: 'Failed to reject content',
      });
    }
  });

  // =========================================================================
  // PERSPECTIVE ASSET UPLOAD
  // =========================================================================

  const ALLOWED_ASSET_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
  ]);

  const assetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_ASSET_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only JPEG, PNG, WebP, GIF, and PDF files are accepted'));
      }
    },
  });

  // POST /api/content/:slug/assets - Upload asset for a perspective
  router.post('/:slug/assets', requireAuth, (req: any, res: any, next: any) => {
    assetUpload.single('file')(req, res, (err: any) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large', message: 'Maximum file size is 50MB' });
        }
        return res.status(400).json({ error: 'Upload error', message: err.message });
      }
      if (err) {
        return res.status(400).json({ error: 'Invalid file type', message: err.message });
      }
      next();
    });
  }, async (req: any, res: any) => {
    try {
      const { slug } = req.params;
      const user = req.user!;
      const file = req.file;
      const assetType = req.body.asset_type as string;

      if (!file) {
        return res.status(400).json({ error: 'A file is required' });
      }
      if (!assetType || !['cover_image', 'report', 'attachment'].includes(assetType)) {
        return res.status(400).json({ error: 'asset_type must be cover_image, report, or attachment' });
      }

      // Image size limit (10MB)
      if (file.mimetype.startsWith('image/') && file.size > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image files must be under 10MB' });
      }

      const pool = getPool();
      const perspResult = await pool.query(
        `SELECT id FROM perspectives WHERE slug = $1`,
        [slug]
      );
      if (perspResult.rows.length === 0) {
        return res.status(404).json({ error: 'Perspective not found' });
      }

      const perspectiveId = perspResult.rows[0].id;

      // Check permission: must be author, proposer, or admin
      const userIsAdmin = await isWebUserAAOAdmin(user.id);
      if (!userIsAdmin) {
        const authorCheck = await pool.query(
          `SELECT 1 FROM perspectives WHERE id = $1 AND (author_user_id = $2 OR proposer_user_id = $2)
           UNION SELECT 1 FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
          [perspectiveId, user.id]
        );
        if (authorCheck.rows.length === 0) {
          return res.status(403).json({ error: 'You must be an author or admin to upload assets' });
        }
      }

      const sanitizedFilename = file.originalname.replace(/[^\w.\-() ]/g, '_').slice(0, 200);

      const asset = await createAsset({
        perspective_id: perspectiveId,
        asset_type: assetType as 'cover_image' | 'report' | 'attachment',
        file_name: sanitizedFilename,
        file_mime_type: file.mimetype,
        file_data: file.buffer,
        uploaded_by_user_id: user.id,
      });

      const baseUrl = process.env.BASE_URL || 'https://agenticadvertising.org';
      const assetUrl = `${baseUrl}/api/perspectives/${slug}/assets/${encodeURIComponent(sanitizedFilename)}`;

      // Auto-update featured_image_url for cover images
      if (assetType === 'cover_image') {
        await pool.query(
          `UPDATE perspectives SET featured_image_url = $1, updated_at = NOW() WHERE id = $2`,
          [assetUrl, perspectiveId]
        );
      }

      logger.info({ assetId: asset.id, slug, assetType, fileName: sanitizedFilename }, 'Perspective asset uploaded');

      res.status(201).json({ asset: { ...asset, url: assetUrl } });
    } catch (error) {
      logger.error({ err: error }, 'Upload perspective asset error');
      res.status(500).json({ error: 'Failed to upload asset' });
    }
  });

  return router;
}

/**
 * Create user content routes (My Content)
 * Returns a router to be mounted at /api/me/content
 */
export function createMyContentRouter(): Router {
  const router = Router();

  // GET /api/me/content - Get all content where user has a relationship
  router.get('/', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const status = req.query.status as string | undefined;
      const collection = req.query.collection as string | undefined;
      const relationship = req.query.relationship as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const pool = getPool();

      // Get committees user leads (for "owner" relationship)
      const leaderResult = await pool.query(
        `SELECT working_group_id FROM working_group_leaders WHERE user_id = $1`,
        [user.id]
      );
      const ledCommitteeIds = leaderResult.rows.map(r => r.working_group_id);

      // Admins can see every perspective here so they can edit anything
      // (including content that predates them, has no proposer, or belongs to a
      // committee they don't lead). Relationships are still computed so the UI
      // can still distinguish their own contributions.
      const userIsAdmin = await isWebUserAAOAdmin(user.id);

      // Build the query
      let query = `
        SELECT DISTINCT ON (p.id)
          p.id, p.slug, p.content_type, p.title, p.subtitle, p.category, p.excerpt,
          p.content, p.tags, p.featured_image_url,
          p.external_url, p.external_site_name, p.status, p.published_at,
          p.created_at, p.updated_at, p.working_group_id, p.proposer_user_id,
          wg.name as committee_name, wg.slug as committee_slug,
          -- Determine relationships
          CASE WHEN p.proposer_user_id = $1 THEN true ELSE false END as is_proposer,
          CASE WHEN EXISTS (SELECT 1 FROM content_authors ca WHERE ca.perspective_id = p.id AND ca.user_id = $1) THEN true ELSE false END as is_author,
          CASE WHEN p.working_group_id = ANY($2) THEN true ELSE false END as is_lead,
          -- Get authors
          (SELECT json_agg(json_build_object(
            'user_id', ca.user_id,
            'display_name', ca.display_name,
            'display_title', ca.display_title
          ) ORDER BY ca.display_order)
          FROM content_authors ca WHERE ca.perspective_id = p.id) as authors
        FROM perspectives p
        LEFT JOIN working_groups wg ON wg.id = p.working_group_id
        WHERE (
          $3::boolean = true
          OR p.proposer_user_id = $1
          OR EXISTS (SELECT 1 FROM content_authors ca WHERE ca.perspective_id = p.id AND ca.user_id = $1)
          OR p.working_group_id = ANY($2)
        )
      `;
      const params: (string | string[] | number | boolean)[] = [user.id, ledCommitteeIds, userIsAdmin];

      // Apply filters
      if (status && status !== 'all') {
        const validStatuses = ['draft', 'pending_review', 'published', 'archived', 'rejected'];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({
            error: 'Invalid status',
            message: `status must be one of: ${validStatuses.join(', ')}, or 'all'`,
          });
        }
        params.push(status);
        query += ` AND p.status = $${params.length}`;
      }

      if (collection) {
        if (collection === 'personal') {
          query += ` AND p.working_group_id IS NULL`;
        } else {
          // Assume it's a committee slug
          params.push(collection);
          query += ` AND wg.slug = $${params.length}`;
        }
      }

      query += ` ORDER BY p.id, p.created_at DESC`;
      params.push(limit);
      query += ` LIMIT $${params.length}`;

      const result = await pool.query(query, params);

      // Format response with relationships
      const items = result.rows.map(row => {
        const relationships: string[] = [];
        if (row.is_author) relationships.push('author');
        if (row.is_proposer) relationships.push('proposer');
        if (row.is_lead) relationships.push('owner');

        return {
          id: row.id,
          slug: row.slug,
          title: row.title,
          subtitle: row.subtitle,
          content_type: row.content_type,
          category: row.category,
          excerpt: row.excerpt,
          content: row.content,
          tags: row.tags,
          featured_image_url: row.featured_image_url,
          external_url: row.external_url,
          external_site_name: row.external_site_name,
          status: row.status,
          collection: {
            type: row.working_group_id ? 'committee' : 'personal',
            committee_name: row.committee_name,
            committee_slug: row.committee_slug,
          },
          relationships,
          authors: row.authors || [],
          published_at: row.published_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
      }).filter(item => {
        // Apply relationship filter if specified
        if (!relationship) return true;
        return item.relationships.includes(relationship);
      });

      const publishedPaths = items
        .filter(item => item.status === 'published' && typeof item.slug === 'string' && item.slug.length > 0)
        .map(item => `/perspectives/${item.slug}`);

      const pageviewCounts = await fetchPathPageviewCounts(publishedPaths, 30);

      const itemsWithPerformance = items.map(item => {
        if (item.status !== 'published' || !item.slug || !pageviewCounts) {
          return item;
        }

        return {
          ...item,
          performance: {
            pageviews_last_30d: pageviewCounts[`/perspectives/${item.slug}`] ?? 0,
          },
        };
      });

      res.json({ items: itemsWithPerformance });
    } catch (error) {
      logger.error({ err: error }, 'GET /api/me/content error');
      res.status(500).json({
        error: 'Failed to get content',
      });
    }
  });

  // PUT /api/me/content/:id - Update content user owns
  router.put('/:id', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const {
        title,
        content,
        content_type,
        excerpt,
        external_url,
        external_site_name,
        category,
        tags,
        author_name,
        content_origin,
        status: requestedStatus,
      } = req.body;
      const pool = getPool();

      // Get the content and check ownership
      const contentResult = await pool.query(
        `SELECT p.*, wg.slug as committee_slug
         FROM perspectives p
         LEFT JOIN working_groups wg ON wg.id = p.working_group_id
         WHERE p.id = $1`,
        [id]
      );

      if (contentResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Content not found',
          message: `No content found with id: ${id}`,
        });
      }

      const contentItem = contentResult.rows[0];

      // Check permission: proposer, author, committee lead, or admin
      const isProposer = contentItem.proposer_user_id === user.id;
      const isAuthor = await pool.query(
        `SELECT 1 FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
        [id, user.id]
      ).then(r => r.rows.length > 0);
      const userIsLead = contentItem.working_group_id
        ? await isCommitteeLead(contentItem.working_group_id, user.id)
        : false;
      const userIsAdmin = await isWebUserAAOAdmin(user.id);

      if (!isProposer && !isAuthor && !userIsLead && !userIsAdmin) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You do not have permission to edit this content',
        });
      }

      // Build update query
      const updates: string[] = [];
      const values: (string | string[] | null)[] = [];
      let paramIndex = 1;

      if (title !== undefined) {
        updates.push(`title = $${paramIndex++}`);
        values.push(title);
      }
      if (content !== undefined) {
        updates.push(`content = $${paramIndex++}`);
        values.push(content);
      }
      if (content_type !== undefined) {
        updates.push(`content_type = $${paramIndex++}`);
        values.push(content_type);
      }
      if (excerpt !== undefined) {
        updates.push(`excerpt = $${paramIndex++}`);
        values.push(excerpt);
      }
      if (external_url !== undefined) {
        updates.push(`external_url = $${paramIndex++}`);
        values.push(external_url);
      }
      if (external_site_name !== undefined) {
        updates.push(`external_site_name = $${paramIndex++}`);
        values.push(external_site_name);
      }
      if (category !== undefined) {
        updates.push(`category = $${paramIndex++}`);
        values.push(category);
      }
      if (tags !== undefined) {
        updates.push(`tags = $${paramIndex++}`);
        values.push(tags);
      }
      if (author_name !== undefined) {
        updates.push(`author_name = $${paramIndex++}`);
        values.push(author_name);
      }
      if (content_origin !== undefined && userIsAdmin) {
        const allowedOrigins = ['official', 'member', 'external'];
        if (allowedOrigins.includes(content_origin)) {
          updates.push(`content_origin = $${paramIndex++}`);
          values.push(content_origin);
        }
      }
      // Allow status changes: members can move their own drafts between
      // draft ↔ pending_review. Moving out of a terminal state (rejected
      // or archived) is gated to admins or the lead of the item's own
      // committee — otherwise an unrelated co-author could resurrect a
      // rejected item without going through the rejecter (see #2713).
      if (requestedStatus !== undefined) {
        const allowedStatuses = ['draft', 'pending_review', 'published', 'archived'];
        if (allowedStatuses.includes(requestedStatus)) {
          // Non-admins can only set draft or pending_review
          if (!userIsAdmin && !['draft', 'pending_review'].includes(requestedStatus)) {
            return res.status(403).json({
              error: 'Permission denied',
              message: 'Only admins can set this status',
            });
          }
          // Moving out of `rejected` or `archived` requires admin or the
          // lead of the item's committee. Prevents a co-author on an
          // unrelated committee from resurrecting a rejected item.
          const currentStatus = contentItem.status as string;
          if (
            (currentStatus === 'rejected' || currentStatus === 'archived')
            && requestedStatus !== currentStatus
            && !userIsAdmin
            && !userIsLead
          ) {
            return res.status(403).json({
              error: 'Permission denied',
              message: `Only an admin or a lead of this item's committee can move it out of ${currentStatus}`,
            });
          }
          updates.push(`status = $${paramIndex++}`);
          values.push(requestedStatus);
          // Auto-set published_at when publishing
          if (requestedStatus === 'published') {
            updates.push(`published_at = COALESCE(published_at, NOW())`);
          }
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: 'No updates provided',
          message: 'Please provide at least one field to update',
        });
      }

      values.push(id);
      const result = await pool.query(
        `UPDATE perspectives SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${paramIndex}
         RETURNING *`,
        values
      );

      logger.info({ contentId: id, userId: user.id }, 'Content updated');

      res.json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error }, 'PUT /api/me/content/:id error');
      res.status(500).json({
        error: 'Failed to update content',
      });
    }
  });

  // DELETE /api/me/content/:id - Delete content the user owns
  // Proposers, authors, and committee leads can delete their own drafts and
  // pending-review items. Admins can delete anything (including published).
  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const pool = getPool();

      const contentResult = await pool.query(
        `SELECT p.id, p.status, p.title, p.proposer_user_id, p.working_group_id
         FROM perspectives p
         WHERE p.id = $1`,
        [id]
      );

      if (contentResult.rows.length === 0) {
        return res.status(404).json({ error: 'Content not found' });
      }

      const contentItem = contentResult.rows[0];

      const isProposer = contentItem.proposer_user_id === user.id;
      const isAuthor = await pool.query(
        `SELECT 1 FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
        [id, user.id]
      ).then(r => r.rows.length > 0);
      const userIsLead = contentItem.working_group_id
        ? await isCommitteeLead(contentItem.working_group_id, user.id)
        : false;
      const userIsAdmin = await isWebUserAAOAdmin(user.id);

      if (!isProposer && !isAuthor && !userIsLead && !userIsAdmin) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You do not have permission to delete this content',
        });
      }

      // Published content requires admin: deleting it breaks incoming links.
      if (contentItem.status === 'published' && !userIsAdmin) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'Published content can only be deleted by an admin. Unpublish it first or ask an admin.',
        });
      }

      await pool.query(`DELETE FROM perspectives WHERE id = $1`, [id]);

      logger.info({ contentId: id, userId: user.id, title: contentItem.title }, 'Content deleted by owner');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'DELETE /api/me/content/:id error');
      res.status(500).json({ error: 'Failed to delete content' });
    }
  });

  // POST /api/me/content/:id/authors - Add co-author to content
  router.post('/:id/authors', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const { user_id, display_name, display_title } = req.body;
      const pool = getPool();

      if (!user_id || !display_name) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'user_id and display_name are required',
        });
      }

      // Check ownership
      const contentResult = await pool.query(
        `SELECT p.*, wg.slug as committee_slug
         FROM perspectives p
         LEFT JOIN working_groups wg ON wg.id = p.working_group_id
         WHERE p.id = $1`,
        [id]
      );

      if (contentResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Content not found',
          message: `No content found with id: ${id}`,
        });
      }

      const contentItem = contentResult.rows[0];

      // Check permission
      const isProposer = contentItem.proposer_user_id === user.id;
      const userIsLead = contentItem.working_group_id
        ? await isCommitteeLead(contentItem.working_group_id, user.id)
        : false;
      const userIsAdmin = await isWebUserAAOAdmin(user.id);

      if (!isProposer && !userIsLead && !userIsAdmin) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You do not have permission to add authors to this content',
        });
      }

      // Get current max display_order
      const orderResult = await pool.query(
        `SELECT COALESCE(MAX(display_order), -1) + 1 as next_order
         FROM content_authors WHERE perspective_id = $1`,
        [id]
      );
      const nextOrder = orderResult.rows[0].next_order;

      // Add the author
      const result = await pool.query(
        `INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (perspective_id, user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           display_title = EXCLUDED.display_title
         RETURNING *`,
        [id, user_id, display_name, display_title, nextOrder]
      );

      logger.info({ contentId: id, authorUserId: user_id }, 'Author added to content');

      res.status(201).json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error }, 'POST /api/me/content/:id/authors error');
      res.status(500).json({
        error: 'Failed to add author',
      });
    }
  });

  // DELETE /api/me/content/:id/authors/:authorId - Remove co-author from content
  router.delete('/:id/authors/:authorId', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id, authorId } = req.params;
      const pool = getPool();

      // Check ownership
      const contentResult = await pool.query(
        `SELECT p.*, wg.slug as committee_slug
         FROM perspectives p
         LEFT JOIN working_groups wg ON wg.id = p.working_group_id
         WHERE p.id = $1`,
        [id]
      );

      if (contentResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Content not found',
          message: `No content found with id: ${id}`,
        });
      }

      const contentItem = contentResult.rows[0];

      // Check permission
      const isProposer = contentItem.proposer_user_id === user.id;
      const userIsLead = contentItem.working_group_id
        ? await isCommitteeLead(contentItem.working_group_id, user.id)
        : false;
      const userIsAdmin = await isWebUserAAOAdmin(user.id);

      if (!isProposer && !userIsLead && !userIsAdmin) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You do not have permission to remove authors from this content',
        });
      }

      // Remove the author
      const result = await pool.query(
        `DELETE FROM content_authors WHERE perspective_id = $1 AND user_id = $2 RETURNING *`,
        [id, authorId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Author not found',
          message: `No author found with id: ${authorId}`,
        });
      }

      logger.info({ contentId: id, authorUserId: authorId }, 'Author removed from content');

      res.json({ success: true, deleted: authorId });
    } catch (error) {
      logger.error({ err: error }, 'DELETE /api/me/content/:id/authors/:authorId error');
      res.status(500).json({
        error: 'Failed to remove author',
      });
    }
  });

  return router;
}
