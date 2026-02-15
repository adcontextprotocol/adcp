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
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { getPool } from '../db/client.js';
import { isWebUserAAOAdmin } from '../addie/mcp/admin-tools.js';
import { sendChannelMessage } from '../slack/client.js';
import { notifyPublishedPost } from '../notifications/slack.js';
import { CommunityDatabase } from '../db/community-db.js';

const logger = createLogger('content-routes');

interface ContentAuthor {
  user_id: string;
  display_name: string;
  display_title?: string;
  display_order?: number;
}

interface ProposeContentRequest {
  title: string;
  content?: string;
  content_type?: 'article' | 'link';
  external_url?: string;
  external_site_name?: string;
  excerpt?: string;
  category?: string;
  tags?: string[];
  collection: {
    type?: 'personal' | 'committee';  // Deprecated - kept for backwards compatibility
    committee_slug?: string;
    slug?: string;  // New format - collection slug directly
  };
  authors?: ContentAuthor[];
}

/**
 * Notify a working group's Slack channel about pending content
 */
async function notifyWorkingGroupOfPendingContent(
  workingGroupId: string,
  perspective: { id: string; title: string; slug: string },
  authorName: string
): Promise<void> {
  const pool = getPool();

  // Get the working group's Slack channel
  const wgResult = await pool.query(
    `SELECT name, slack_channel_id FROM working_groups WHERE id = $1`,
    [workingGroupId]
  );

  if (wgResult.rows.length === 0 || !wgResult.rows[0].slack_channel_id) {
    logger.debug({ workingGroupId }, 'Working group has no Slack channel, skipping notification');
    return;
  }

  const { name: wgName, slack_channel_id: slackChannelId } = wgResult.rows[0];

  try {
    await sendChannelMessage(slackChannelId, {
      text: `New content pending review: "${perspective.title}" by ${authorName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📝 *New content submitted for review*\n\n*Title:* ${perspective.title}\n*Author:* ${authorName}\n*Collection:* ${wgName}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Review Content',
                emoji: true,
              },
              url: `https://agenticadvertising.org/my-content.html`,
              action_id: 'review_content',
            },
          ],
        },
      ],
    });

    logger.info({ workingGroupId, perspectiveId: perspective.id, slackChannelId }, 'Sent pending content notification to working group');
  } catch (error) {
    logger.error({ error, workingGroupId, perspectiveId: perspective.id }, 'Failed to send pending content notification');
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
async function getUserInfo(userId: string): Promise<{ name: string; title?: string } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT first_name, last_name, title, email FROM users WHERE workos_user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  const user = result.rows[0];
  const name = user.first_name && user.last_name
    ? `${user.first_name} ${user.last_name}`
    : user.email?.split('@')[0] || 'Unknown';
  return { name, title: user.title };
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
    content,
    content_type = 'article',
    external_url,
    external_site_name,
    excerpt,
    category,
    tags = [],
    collection,
    authors,
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

  // Determine if user can publish directly (leads and admins only)
  const canPublishDirectly = userIsLead || userIsAdmin;

  // Generate slug from title
  const baseSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 100);
  const slug = `${baseSlug}-${Date.now().toString(36)}`;

  // Determine initial status
  const status = canPublishDirectly ? 'published' : 'pending_review';
  const publishedAt = canPublishDirectly ? new Date().toISOString() : null;
  const proposedAt = new Date().toISOString();

  // Get author info for display
  const userInfo = await getUserInfo(user.id);
  const authorName = userInfo?.name || user.email?.split('@')[0] || 'Unknown';
  const authorTitle = userInfo?.title;

  // Insert the content
  const result = await pool.query(
    `INSERT INTO perspectives (
      slug, content_type, title, content, excerpt,
      external_url, external_site_name, category, tags,
      author_name, author_title, author_user_id,
      proposer_user_id, proposed_at,
      working_group_id, status, published_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *`,
    [
      slug, content_type, title, content, excerpt,
      external_url, external_site_name, category, tags,
      authorName, authorTitle, user.id,
      user.id, proposedAt,
      committeeId, status, publishedAt,
    ]
  );

  const perspective = result.rows[0];

  // Create content_authors records
  const authorsToCreate = authors && authors.length > 0
    ? authors
    : [{ user_id: user.id, display_name: authorName, display_title: authorTitle, display_order: 0 }];

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

  // Notify working group if content needs review
  if (status === 'pending_review') {
    notifyWorkingGroupOfPendingContent(committeeId, perspective, authorName).catch(err => {
      logger.error({ err, perspectiveId: perspective.id, committeeId, authorName }, 'Failed to send content notification');
    });
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

  const message = canPublishDirectly
    ? 'Content published successfully'
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/content/propose - Submit content to any collection
  router.post('/propose', requireAuth, async (req, res) => {
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/content/pending - List pending content user can review
  router.get('/pending', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const committeeSlug = req.query.committee_slug as string | undefined;
      const pool = getPool();

      // Get committees user leads
      // Join with slack_user_mappings to handle users who were added as leader via Slack ID
      const leaderResult = await pool.query(
        `SELECT wg.id, wg.name, wg.slug
         FROM working_group_leaders wgl
         LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
         JOIN working_groups wg ON wg.id = wgl.working_group_id
         WHERE wgl.user_id = $1 OR sm.workos_user_id = $1`,
        [user.id]
      );
      const ledCommittees = leaderResult.rows;
      const ledCommitteeIds = ledCommittees.map(c => c.id);

      // Check if admin
      const userIsAdmin = await isWebUserAAOAdmin(user.id);

      if (!userIsAdmin && ledCommitteeIds.length === 0) {
        return res.json({
          items: [],
          summary: { total: 0, by_collection: {} },
        });
      }

      // Build query for pending content
      let query = `
        SELECT
          p.id, p.title, p.excerpt, p.slug, p.content_type,
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
        // Non-admins only see pending for committees they lead
        params.push(ledCommitteeIds);
        query += ` AND p.working_group_id = ANY($${params.length})`;
      }

      if (committeeSlug) {
        params.push(committeeSlug);
        query += ` AND wg.slug = $${params.length}`;
      }

      query += ` ORDER BY p.proposed_at ASC`;

      const result = await pool.query(query, params);

      // Format response
      const items = result.rows.map(row => ({
        id: row.id,
        title: row.title,
        slug: row.slug,
        excerpt: row.excerpt,
        content_type: row.content_type,
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

      // Calculate summary
      const byCollection: Record<string, number> = {};
      for (const item of items) {
        const key = item.collection.committee_slug || 'personal';
        byCollection[key] = (byCollection[key] || 0) + 1;
      }

      res.json({
        items,
        summary: {
          total: items.length,
          by_collection: byCollection,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'GET /api/content/pending error');
      res.status(500).json({
        error: 'Failed to get pending content',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/content/:id/approve - Approve pending content
  router.post('/:id/approve', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const { publish_immediately = true } = req.body;
      const pool = getPool();

      // Get the content with working group details
      const contentResult = await pool.query(
        `SELECT p.*, wg.slug as committee_slug, wg.name as committee_name, wg.slack_channel_id
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

      const content = contentResult.rows[0];

      if (content.status !== 'pending_review') {
        return res.status(400).json({
          error: 'Invalid status',
          message: `Content is not pending review (current status: ${content.status})`,
        });
      }

      // Check permission
      const userIsAdmin = await isWebUserAAOAdmin(user.id);
      const userIsLead = content.working_group_id
        ? await isCommitteeLead(content.working_group_id, user.id)
        : false;

      if (!userIsAdmin && !userIsLead) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You do not have permission to approve this content',
        });
      }

      // Update status
      const newStatus = publish_immediately ? 'published' : 'draft';
      const publishedAt = publish_immediately ? new Date().toISOString() : null;

      await pool.query(
        `UPDATE perspectives
         SET status = $1, published_at = $2,
             reviewed_by_user_id = $3, reviewed_at = NOW()
         WHERE id = $4`,
        [newStatus, publishedAt, user.id, id]
      );

      logger.info({
        contentId: id,
        reviewerId: user.id,
        newStatus,
        committeeSlug: content.committee_slug,
      }, 'Content approved');

      // Send Slack notification when content is published
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
      }

      res.json({
        success: true,
        status: newStatus,
        message: publish_immediately
          ? 'Content approved and published'
          : 'Content approved and saved as draft',
      });
    } catch (error) {
      logger.error({ err: error }, 'POST /api/content/:id/approve error');
      res.status(500).json({
        error: 'Failed to approve content',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      // Fetch the page
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AgenticAdvertising/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
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
        return text
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
          .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
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
          site_name = parsedUrl.hostname.replace('www.', '');
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/content/:id/reject - Reject pending content
  router.post('/:id/reject', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;
      const { reason } = req.body;
      const pool = getPool();

      if (!reason) {
        return res.status(400).json({
          error: 'Missing reason',
          message: 'A reason is required when rejecting content',
        });
      }

      // Get the content
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

      const content = contentResult.rows[0];

      if (content.status !== 'pending_review') {
        return res.status(400).json({
          error: 'Invalid status',
          message: `Content is not pending review (current status: ${content.status})`,
        });
      }

      // Check permission
      const userIsAdmin = await isWebUserAAOAdmin(user.id);
      const userIsLead = content.working_group_id
        ? await isCommitteeLead(content.working_group_id, user.id)
        : false;

      if (!userIsAdmin && !userIsLead) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You do not have permission to reject this content',
        });
      }

      // Update status
      await pool.query(
        `UPDATE perspectives
         SET status = 'rejected', rejection_reason = $1,
             reviewed_by_user_id = $2, reviewed_at = NOW()
         WHERE id = $3`,
        [reason, user.id, id]
      );

      logger.info({
        contentId: id,
        reviewerId: user.id,
        reason,
        committeeSlug: content.committee_slug,
      }, 'Content rejected');

      res.json({
        success: true,
        status: 'rejected',
        message: 'Content rejected',
      });
    } catch (error) {
      logger.error({ err: error }, 'POST /api/content/:id/reject error');
      res.status(500).json({
        error: 'Failed to reject content',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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

      // Build the query
      let query = `
        SELECT DISTINCT ON (p.id)
          p.id, p.slug, p.content_type, p.title, p.subtitle, p.category, p.excerpt,
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
          p.proposer_user_id = $1
          OR EXISTS (SELECT 1 FROM content_authors ca WHERE ca.perspective_id = p.id AND ca.user_id = $1)
          OR p.working_group_id = ANY($2)
        )
      `;
      const params: (string | string[] | number)[] = [user.id, ledCommitteeIds];

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

      res.json({ items });
    } catch (error) {
      logger.error({ err: error }, 'GET /api/me/content error');
      res.status(500).json({
        error: 'Failed to get content',
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
