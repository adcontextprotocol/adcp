/**
 * Committee routes module
 *
 * Handles all API routes for committees (working groups, councils, chapters, governance)
 * including admin, public, and leader-only endpoints.
 */

import { Router, Request, Response } from "express";
import { WorkOS } from "@workos-inc/node";
import { getPool, query } from "../db/client.js";
import { createLogger } from "../logger.js";
import { isUuid } from "../utils/uuid.js";
import { requireAuth, requireAdmin, optionalAuth, createRequireWorkingGroupLeader, createRequireWorkingGroupMember } from "../middleware/auth.js";
import { WorkingGroupDatabase } from "../db/working-group-db.js";
import { eventsDb } from "../db/events-db.js";
import { invalidateMemberContextCache } from "../addie/index.js";
import { invalidateWebAdminStatusCache, isWebUserAAOAdmin } from "../addie/mcp/admin-tools.js";
import { syncWorkingGroupMembersFromSlack, syncAllWorkingGroupMembersFromSlack } from "../slack/sync.js";
import { notifyPublishedPost } from "../notifications/slack.js";
import { notifyUser } from "../notifications/notification-service.js";
import { decodeHtmlEntities } from "../utils/html-entities.js";
import { validateFetchUrl, validateRedirectTarget, sanitizeUrl } from "../utils/url-security.js";
import { reindexDocument } from "../addie/jobs/committee-document-indexer.js";
import { refreshWorkingGroupDocs } from "../addie/mcp/docs-indexer.js";
import { createChannel, setChannelPurpose, sendChannelMessage, inviteToChannel, isSlackConfigured } from "../slack/client.js";
import { SlackDatabase } from "../db/slack-db.js";
import { CommunityDatabase } from "../db/community-db.js";
import multer from 'multer';
import { sendWgWelcomeMessage } from "../addie/services/wg-welcome.js";
import {
  joinWorkingGroup as joinWorkingGroupService,
  expressCommitteeInterest as expressCommitteeInterestService,
  withdrawCommitteeInterest as withdrawCommitteeInterestService,
  WorkingGroupMembershipError,
} from "../services/working-group-membership-service.js";
import {
  createWorkingGroupPost as createWorkingGroupPostService,
  addCommitteeDocument as addCommitteeDocumentService,
  updateCommitteeDocument as updateCommitteeDocumentService,
  deleteCommitteeDocument as deleteCommitteeDocumentService,
  WorkingGroupContentError,
} from "../services/working-group-content-service.js";

const logger = createLogger("committee-routes");

// File upload config for working group documents (PDF/PPTX only, 50MB limit)
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req: Request, file: { mimetype: string }, cb: (error: Error | null, acceptFile?: boolean) => void) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, PPTX, XLSX, and DOCX files are accepted'));
    }
  },
});

// Rate limiting for reindex endpoint (prevent API cost abuse)
const reindexRateLimit = new Map<string, number[]>();
const REINDEX_RATE_LIMIT = 5; // Max requests
const REINDEX_RATE_WINDOW = 60 * 1000; // Per minute

function checkReindexRateLimit(userId: string): boolean {
  const now = Date.now();
  const requests = reindexRateLimit.get(userId) || [];
  const recentRequests = requests.filter(time => now - time < REINDEX_RATE_WINDOW);

  if (recentRequests.length >= REINDEX_RATE_LIMIT) {
    return false;
  }

  recentRequests.push(now);
  reindexRateLimit.set(userId, recentRequests);
  return true;
}

// Document URL allowlist + helper now live in
// services/working-group-content-service so the route and the Addie
// tool consume the same rules.

// Valid committee types
const VALID_COMMITTEE_TYPES = ['working_group', 'council', 'chapter', 'governance', 'industry_gathering'] as const;

/**
 * Validate slug format based on committee type.
 * Industry gatherings use hierarchical slugs: industry-gatherings/YYYY/name
 * Other committee types use simple slugs: lowercase letters, numbers, hyphens
 */
function isValidCommitteeSlug(slug: string, committeeType?: string): boolean {
  if (committeeType === 'industry_gathering') {
    // Industry gatherings: industry-gatherings/YYYY/name-slug
    // Allow lowercase letters, numbers, hyphens, and forward slashes
    // Disallow consecutive slashes, consecutive hyphens, or slash-hyphen combinations
    return /^[a-z0-9/-]+$/.test(slug)
      && !slug.startsWith('/')
      && !slug.endsWith('/')
      && !slug.includes('//')
      && !slug.includes('--')
      && !/-\/|\/\-/.test(slug);
  }
  // Standard committees: lowercase letters, numbers, hyphens only
  return /^[a-z0-9-]+$/.test(slug) && !slug.includes('--');
}
type CommitteeType = typeof VALID_COMMITTEE_TYPES[number];

// Initialize WorkOS client only if authentication is enabled
const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, {
      clientId: process.env.WORKOS_CLIENT_ID!,
    })
  : null;

/**
 * Fetch and extract metadata from a URL (for link posts)
 */
async function fetchUrlMetadata(url: string): Promise<{ title: string; excerpt: string; site_name: string }> {
  const parsedUrl = new URL(url);
  await validateFetchUrl(parsedUrl);

  // Reconstruct URL from validated components to break CodeQL taint chain
  let fetchUrl = sanitizeUrl(parsedUrl);

  let response = await fetch(fetchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AgenticAdvertising/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'manual',
  });

  // Follow up to 3 redirects with SSRF validation on each target
  for (let i = 0; i < 3 && [301, 302, 303, 307, 308].includes(response.status); i++) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect with no location header');
    const redirectUrl = await validateRedirectTarget(location, parsedUrl);
    fetchUrl = sanitizeUrl(redirectUrl);
    response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgenticAdvertising/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
    });
  }

  if (!response.ok && [301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error('Too many redirects');
  }

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

  let title = ogTitleMatch?.[1] || titleMatch?.[1] || '';
  title = decodeHtmlEntities(title.trim());

  let excerpt = ogDescMatch?.[1] || descMatch?.[1] || '';
  excerpt = decodeHtmlEntities(excerpt.trim());
  if (excerpt.length > 160) {
    excerpt = excerpt.substring(0, 157) + '...';
  }

  let site_name = ogSiteMatch?.[1] || '';
  if (!site_name) {
    try {
      const parsedUrl = new URL(url);
      site_name = parsedUrl.hostname.replace('www.', '');
      site_name = site_name.charAt(0).toUpperCase() + site_name.slice(1);
    } catch {
      // ignore URL parse errors
    }
  }
  site_name = decodeHtmlEntities(site_name);

  return { title, excerpt, site_name };
}

/**
 * Create committee routes
 * Returns routers for admin API (/api/admin/working-groups), public API (/api/working-groups),
 * and user API (/api/me/working-groups)
 */
export function createCommitteeRouters(): {
  adminApiRouter: Router;
  publicApiRouter: Router;
  userApiRouter: Router;
} {
  const adminApiRouter = Router();
  const publicApiRouter = Router();
  const userApiRouter = Router();

  const workingGroupDb = new WorkingGroupDatabase();
  const requireWorkingGroupLeader = createRequireWorkingGroupLeader(workingGroupDb);
  const requireWorkingGroupMember = createRequireWorkingGroupMember(workingGroupDb);

  // =========================================================================
  // ADMIN API ROUTES (/api/admin/working-groups)
  // =========================================================================

  // GET /api/admin/working-groups - List all working groups
  adminApiRouter.get('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const typeParam = req.query.type as string | undefined;
      let committeeType: CommitteeType | undefined;
      if (typeParam && VALID_COMMITTEE_TYPES.includes(typeParam as CommitteeType)) {
        committeeType = typeParam as CommitteeType;
      }

      const groups = await workingGroupDb.listWorkingGroups({
        includePrivate: true,
        committee_type: committeeType,
      });
      res.json(groups);
    } catch (error) {
      logger.error({ err: error }, 'List working groups error:');
      res.status(500).json({
        error: 'Failed to list working groups',
      });
    }
  });

  // GET /api/admin/working-groups/search-users - Search users for leadership selection
  adminApiRouter.get('/search-users', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string' || q.length < 2) {
        return res.json([]);
      }

      const results = await workingGroupDb.searchUsersForLeadership(q, 20);
      res.json(results);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('organization_memberships') && errorMessage.includes('does not exist')) {
        logger.warn('organization_memberships table not found - run migrations and backfill');
        return res.status(503).json({
          error: 'User search not yet configured',
          message: 'Run database migrations and then call POST /api/admin/users/sync-workos to populate user data',
        });
      }

      logger.error({ err: error }, 'Search users error:');
      res.status(500).json({
        error: 'Failed to search users',
        message: 'An internal error occurred while searching users.',
      });
    }
  });

  // POST /api/admin/working-groups/sync-all-from-slack - Sync all working groups with Slack channels
  adminApiRouter.post('/sync-all-from-slack', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const results = await syncAllWorkingGroupMembersFromSlack();

      const totalAdded = results.reduce((sum, r) => sum + r.members_added, 0);
      const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

      res.json({
        success: true,
        summary: {
          groups_synced: results.length,
          total_members_added: totalAdded,
          total_errors: totalErrors
        },
        results
      });
    } catch (error) {
      logger.error({ err: error }, 'Sync all working groups from Slack error:');
      res.status(500).json({
        error: 'Failed to sync working groups',
      });
    }
  });

  // GET /api/admin/working-groups/:id - Get single working group with details
  adminApiRouter.get('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const group = await workingGroupDb.getWorkingGroupWithDetails(id);

      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with id ${id}`
        });
      }

      res.json(group);
    } catch (error) {
      logger.error({ err: error }, 'Get working group error:');
      res.status(500).json({
        error: 'Failed to get working group',
      });
    }
  });

  // POST /api/admin/working-groups - Create working group
  adminApiRouter.post('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { name, slug, description, slack_channel_url, is_private, status, display_order,
              leader_user_ids, committee_type, region, parent_id } = req.body;

      if (!name || !slug) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'Name and slug are required'
        });
      }

      if (committee_type && !VALID_COMMITTEE_TYPES.includes(committee_type)) {
        return res.status(400).json({
          error: 'Invalid committee type',
          message: 'Committee type must be working_group, council, chapter, governance, or industry_gathering'
        });
      }

      if (!isValidCommitteeSlug(slug, committee_type)) {
        const message = committee_type === 'industry_gathering'
          ? 'Slug must contain only lowercase letters, numbers, hyphens, and forward slashes'
          : 'Slug must contain only lowercase letters, numbers, and hyphens';
        return res.status(400).json({
          error: 'Invalid slug',
          message
        });
      }

      const finalRegion = committee_type === 'chapter' ? region : null;

      const slugAvailable = await workingGroupDb.isSlugAvailable(slug);
      if (!slugAvailable) {
        return res.status(409).json({
          error: 'Slug already exists',
          message: `A working group with slug '${slug}' already exists`
        });
      }

      // Auto-create Slack channel for industry gatherings if not provided
      let finalSlackChannelUrl = slack_channel_url;
      let autoCreatedChannel = null;
      if (committee_type === 'industry_gathering' && !slack_channel_url) {
        // Generate channel name from the name (e.g., "CES 2026" -> "ces-2026")
        const channelName = name.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 80);

        const channelResult = await createChannel(channelName);
        if (channelResult) {
          finalSlackChannelUrl = channelResult.url;
          autoCreatedChannel = channelResult;

          // Set channel purpose
          const purpose = description || `Connect with AgenticAdvertising.org members at ${name}.`;
          await setChannelPurpose(channelResult.channel.id, purpose);

          logger.info(
            { channelId: channelResult.channel.id, name: channelName },
            'Auto-created Slack channel for industry gathering'
          );
        } else {
          logger.warn(
            { name },
            'Failed to auto-create Slack channel for industry gathering'
          );
        }
      }

      const group = await workingGroupDb.createWorkingGroup({
        name, slug, description, slack_channel_url: finalSlackChannelUrl, is_private, status, display_order,
        leader_user_ids, committee_type, region: finalRegion, parent_id: parent_id || null
      });

      // Auto-sync members from Slack channel if a channel was linked to a chapter or event
      let syncResult = null;
      if (group.slack_channel_id && (group.committee_type === 'chapter' || group.committee_type === 'industry_gathering')) {
        syncResult = await syncWorkingGroupMembersFromSlack(group.id);
        if (syncResult.members_added > 0) {
          logger.info(
            { workingGroupId: group.id, membersAdded: syncResult.members_added },
            'Auto-synced members after chapter/event was created with Slack channel'
          );
          invalidateMemberContextCache();
        }
      }

      res.status(201).json({
        ...group,
        sync_result: syncResult,
        slack_channel_auto_created: !!autoCreatedChannel,
        slack_channel_warning: (committee_type === 'industry_gathering' && !slack_channel_url && !autoCreatedChannel)
          ? 'Slack channel auto-creation failed. You may need to manually create and link a channel.'
          : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.includes('cycle') ||
        message.includes('own parent') ||
        message.includes('Parent working group not found') ||
        message.includes('limited to two levels') ||
        message.includes('cannot have subgroups') ||
        message.includes('while subgroups exist')
      ) {
        return res.status(400).json({ error: 'Invalid hierarchy', message });
      }
      logger.error({ err: error }, 'Create working group error:');
      res.status(500).json({
        error: 'Failed to create working group',
      });
    }
  });

  // PUT /api/admin/working-groups/:id - Update working group
  adminApiRouter.put('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      if (updates.committee_type && !VALID_COMMITTEE_TYPES.includes(updates.committee_type)) {
        return res.status(400).json({
          error: 'Invalid committee type',
          message: 'Committee type must be working_group, council, chapter, governance, or industry_gathering'
        });
      }

      if (updates.committee_type && updates.committee_type !== 'chapter') {
        updates.region = null;
      }

      // Check if we're adding/changing a Slack channel
      const existingGroup = await workingGroupDb.getWorkingGroupById(id);

      // Validate slug format and uniqueness if changing
      if (updates.slug) {
        // Use the committee type being set, or fall back to existing
        const effectiveCommitteeType = updates.committee_type || existingGroup?.committee_type;
        if (!isValidCommitteeSlug(updates.slug, effectiveCommitteeType)) {
          const message = effectiveCommitteeType === 'industry_gathering'
            ? 'Slug must contain only lowercase letters, numbers, hyphens, and forward slashes'
            : 'Slug must contain only lowercase letters, numbers, and hyphens';
          return res.status(400).json({
            error: 'Invalid slug',
            message
          });
        }

        const slugAvailable = await workingGroupDb.isSlugAvailable(updates.slug, id);
        if (!slugAvailable) {
          return res.status(409).json({
            error: 'Slug already exists',
            message: `A working group with slug '${updates.slug}' already exists`
          });
        }
      }
      const isAddingChannel = updates.slack_channel_url && (!existingGroup?.slack_channel_id || updates.slack_channel_url !== existingGroup.slack_channel_url);

      // Track existing leaders before update so we can invite new ones to Slack
      const existingLeaderIds = new Set(existingGroup?.leaders?.map(l => l.user_id) ?? []);

      const group = await workingGroupDb.updateWorkingGroup(id, updates);

      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with id ${id}`
        });
      }

      // Auto-invite newly added leaders to the group's Slack channel (fire-and-forget)
      if (updates.leader_user_ids && group.slack_channel_id) {
        const newLeaderIds = (updates.leader_user_ids as string[]).filter(uid => !existingLeaderIds.has(uid));
        if (newLeaderIds.length > 0) {
          const slackDb = new SlackDatabase();
          Promise.all(newLeaderIds.map(uid => slackDb.getByWorkosUserId(uid))).then(mappings => {
            const slackUserIds = mappings
              .filter((m): m is NonNullable<typeof m> => !!m?.slack_user_id)
              .map(m => m.slack_user_id);
            if (slackUserIds.length > 0) {
              return inviteToChannel(group.slack_channel_id!, slackUserIds);
            }
          }).catch(err => {
            logger.error({ err, workingGroupId: id }, 'Failed to auto-invite leaders to Slack channel');
          });
        }
      }

      // Auto-sync members from Slack channel if a new channel was linked to a chapter or event
      let syncResult = null;
      if (isAddingChannel && group.slack_channel_id && (group.committee_type === 'chapter' || group.committee_type === 'industry_gathering')) {
        syncResult = await syncWorkingGroupMembersFromSlack(id);
        if (syncResult.members_added > 0) {
          logger.info(
            { workingGroupId: id, membersAdded: syncResult.members_added },
            'Auto-synced members after channel was linked'
          );
          invalidateMemberContextCache();
        }
      }

      res.json({
        ...group,
        sync_result: syncResult,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.includes('cycle') ||
        message.includes('own parent') ||
        message.includes('Parent working group not found') ||
        message.includes('limited to two levels') ||
        message.includes('cannot have subgroups') ||
        message.includes('while subgroups exist')
      ) {
        return res.status(400).json({ error: 'Invalid hierarchy', message });
      }
      logger.error({ err: error }, 'Update working group error:');
      res.status(500).json({
        error: 'Failed to update working group',
      });
    }
  });

  // POST /api/admin/working-groups/:id/deactivate - Deactivate working group
  adminApiRouter.post('/:id/deactivate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!isUuid(id)) {
        return res.status(400).json({ error: 'Invalid working group ID' });
      }
      const deactivated = await workingGroupDb.deactivateWorkingGroup(id);

      if (!deactivated) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with id ${id}`
        });
      }

      invalidateMemberContextCache();
      res.json({ success: true, deactivated: id });
    } catch (error) {
      logger.error({ err: error }, 'Deactivate working group error:');
      res.status(500).json({
        error: 'Failed to deactivate working group',
      });
    }
  });

  // POST /api/admin/working-groups/:id/reactivate - Reactivate working group
  adminApiRouter.post('/:id/reactivate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!isUuid(id)) {
        return res.status(400).json({ error: 'Invalid working group ID' });
      }
      const reactivated = await workingGroupDb.reactivateWorkingGroup(id);

      if (!reactivated) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with id ${id}`
        });
      }

      invalidateMemberContextCache();
      res.json({ success: true, reactivated: id });
    } catch (error) {
      logger.error({ err: error }, 'Reactivate working group error:');
      res.status(500).json({
        error: 'Failed to reactivate working group',
      });
    }
  });

  // GET /api/admin/working-groups/:id/members - List working group members
  adminApiRouter.get('/:id/members', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const members = await workingGroupDb.getMembershipsByWorkingGroup(id);
      res.json(members);
    } catch (error) {
      logger.error({ err: error }, 'List working group members error:');
      res.status(500).json({
        error: 'Failed to list members',
      });
    }
  });

  // POST /api/admin/working-groups/:id/members - Add member to working group
  adminApiRouter.post('/:id/members', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { workos_user_id, user_email, user_name, user_org_name, workos_organization_id } = req.body;
      const user = req.user!;

      if (!workos_user_id) {
        return res.status(400).json({
          error: 'Missing required field',
          message: 'workos_user_id is required'
        });
      }

      const membership = await workingGroupDb.addMembership({
        working_group_id: id,
        workos_user_id,
        user_email,
        user_name,
        user_org_name,
        workos_organization_id,
        added_by_user_id: user.id,
      });

      invalidateMemberContextCache();
      invalidateWebAdminStatusCache(workos_user_id);

      // Auto-invite new member to the group's Slack channel (fire-and-forget)
      const group = await workingGroupDb.getWorkingGroupById(id);
      if (group?.slack_channel_id) {
        const slackDb = new SlackDatabase();
        slackDb.getByWorkosUserId(workos_user_id).then(mapping => {
          if (mapping?.slack_user_id) {
            return inviteToChannel(group.slack_channel_id!, [mapping.slack_user_id]);
          }
        }).catch(err => {
          logger.error({ err, userId: workos_user_id, channelId: group.slack_channel_id }, 'Failed to auto-invite to Slack channel on admin add');
        });
      }

      res.status(201).json(membership);
    } catch (error) {
      logger.error({ err: error }, 'Add working group member error:');
      res.status(500).json({
        error: 'Failed to add member',
      });
    }
  });

  // DELETE /api/admin/working-groups/:id/members/:userId - Remove member from working group
  adminApiRouter.delete('/:id/members/:userId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id, userId } = req.params;
      const deleted = await workingGroupDb.deleteMembership(id, userId);

      if (!deleted) {
        return res.status(404).json({
          error: 'Membership not found',
          message: 'User is not a member of this working group'
        });
      }

      invalidateMemberContextCache();
      invalidateWebAdminStatusCache(userId);

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Remove working group member error:');
      res.status(500).json({
        error: 'Failed to remove member',
      });
    }
  });

  // POST /api/admin/working-groups/:slug/topics/:topicSlug/graduate
  // Promote a topic on the given working group into a full subgroup.
  const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
  adminApiRouter.post('/:slug/topics/:topicSlug/graduate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { slug, topicSlug } = req.params;
      if (!SLUG_PATTERN.test(slug) || !SLUG_PATTERN.test(topicSlug)) {
        return res.status(400).json({ error: 'Invalid slug format' });
      }
      const result = await workingGroupDb.graduateTopicToSubgroup(slug, topicSlug);
      invalidateMemberContextCache();
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (
        message.includes('not found') ||
        message.includes('Cannot graduate') ||
        message.includes('hierarchy is two levels')
      ) {
        return res.status(400).json({ error: 'Graduate failed', message });
      }
      logger.error({ err: error }, 'Graduate topic error');
      res.status(500).json({ error: 'Failed to graduate topic', message });
    }
  });

  // GET /api/admin/working-groups/:id/interest - Get users who expressed interest in a committee

  adminApiRouter.get('/:id/interest', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const workingGroup = await workingGroupDb.getWorkingGroupById(id);
      if (!workingGroup) {
        return res.status(404).json({
          error: 'Working group not found',
          message: 'The specified working group does not exist'
        });
      }

      const pool = getPool();
      const result = await pool.query(
        `SELECT ci.id, ci.workos_user_id, ci.user_email, ci.user_name, ci.user_org_name,
                ci.interest_level, ci.created_at
         FROM committee_interest ci
         WHERE ci.working_group_id = $1
         ORDER BY ci.created_at DESC`,
        [id]
      );

      res.json({ interest: result.rows });
    } catch (error) {
      logger.error({ err: error }, 'List committee interest error:');
      res.status(500).json({
        error: 'Failed to list interest records',
      });
    }
  });

  // POST /api/admin/working-groups/:id/sync-from-slack - Sync members from Slack channel
  adminApiRouter.post('/:id/sync-from-slack', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const workingGroup = await workingGroupDb.getWorkingGroupById(id);
      if (!workingGroup) {
        return res.status(404).json({
          error: 'Working group not found',
          message: 'The specified working group does not exist'
        });
      }

      const result = await syncWorkingGroupMembersFromSlack(id);

      if (result.errors.length > 0 && result.members_added === 0 && result.members_already_in_group === 0) {
        return res.status(400).json({
          error: 'Sync failed',
          message: result.errors[0],
          result
        });
      }

      if (result.members_added > 0) {
        invalidateMemberContextCache();
      }

      res.json({
        success: true,
        result
      });
    } catch (error) {
      logger.error({ err: error }, 'Sync working group members from Slack error:');
      res.status(500).json({
        error: 'Failed to sync members',
      });
    }
  });

  // GET /api/admin/working-groups/:id/posts - List all posts for a working group
  adminApiRouter.get('/:id/posts', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const pool = getPool();

      const result = await pool.query(
        `SELECT id, slug, content_type, title, subtitle, category, excerpt,
          external_url, external_site_name, author_name, author_title,
          author_user_id, featured_image_url, status, published_at, display_order, tags
        FROM perspectives
        WHERE working_group_id = $1
        ORDER BY published_at DESC NULLS LAST, created_at DESC`,
        [id]
      );

      res.json(result.rows);
    } catch (error) {
      logger.error({ err: error }, 'List working group posts error:');
      res.status(500).json({
        error: 'Failed to list posts',
      });
    }
  });

  // =========================================================================
  // PUBLIC API ROUTES (/api/working-groups)
  // =========================================================================

  // GET /api/working-groups - List active working groups
  publicApiRouter.get('/', optionalAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user;

      const typeParam = req.query.type as string | undefined;
      let committeeTypes: CommitteeType[] | undefined;
      if (typeParam) {
        const filtered = typeParam.split(',').filter(t =>
          VALID_COMMITTEE_TYPES.includes(t as CommitteeType)
        ) as CommitteeType[];
        committeeTypes = filtered.length > 0 ? filtered : undefined;
      }

      let groups;
      if (user?.id) {
        groups = await workingGroupDb.listWorkingGroupsForUser(user.id, {
          committee_type: committeeTypes,
          excludeGovernance: true,
        });
      } else {
        groups = await workingGroupDb.listWorkingGroups({
          status: 'active',
          includePrivate: false,
          committee_type: committeeTypes,
          excludeGovernance: true,
        });
      }

      res.json({ working_groups: groups });
    } catch (error) {
      logger.error({ err: error }, 'List working groups error');
      res.status(500).json({
        error: 'Failed to list working groups',
      });
    }
  });

  // GET /api/working-groups/industry-gatherings - Get industry gatherings with linked event info
  publicApiRouter.get('/industry-gatherings', async (req: Request, res: Response) => {
    try {
      const gatherings = await workingGroupDb.getIndustryGatherings();

      // Fetch linked event info for each gathering
      const gatheringsWithEvents = await Promise.all(
        gatherings.map(async (gathering) => {
          let linkedEvent = null;
          if (gathering.linked_event_id) {
            const event = await eventsDb.getEventById(gathering.linked_event_id);
            if (event) {
              linkedEvent = {
                id: event.id,
                slug: event.slug,
                title: event.title,
                start_time: event.start_time,
                end_time: event.end_time,
                timezone: event.timezone,
                venue_city: event.venue_city,
                venue_state: event.venue_state,
                event_format: event.event_format,
                featured_image_url: event.featured_image_url,
              };
            }
          }
          return {
            ...gathering,
            linked_event: linkedEvent,
          };
        })
      );

      res.json({ industry_gatherings: gatheringsWithEvents });
    } catch (error) {
      logger.error({ err: error }, 'List industry gatherings error');
      res.status(500).json({
        error: 'Failed to list industry gatherings',
      });
    }
  });

  // GET /api/working-groups/for-organization/:orgId - Get working groups for an organization
  publicApiRouter.get('/for-organization/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      const groups = await workingGroupDb.getWorkingGroupsForOrganization(orgId);
      res.json({ working_groups: groups });
    } catch (error) {
      logger.error({ err: error }, 'Get org working groups error');
      res.status(500).json({
        error: 'Failed to get working groups',
      });
    }
  });

  // GET /api/working-groups/:slug - Get working group details
  publicApiRouter.get('/:slug', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      if (group.is_private) {
        if (!user?.id) {
          return res.status(404).json({
            error: 'Working group not found',
            message: `No working group found with slug: ${slug}`,
          });
        }

        const isMember = await workingGroupDb.isMember(group.id, user.id);
        if (!isMember) {
          return res.status(404).json({
            error: 'Working group not found',
            message: `No working group found with slug: ${slug}`,
          });
        }
      }

      const memberships = await workingGroupDb.getMembershipsByWorkingGroup(group.id);

      let isMember = false;
      let isFamilyMember = false;
      if (user?.id) {
        isMember = await workingGroupDb.isMember(group.id, user.id);
        isFamilyMember = isMember || await workingGroupDb.isFamilyMember(group.id, user.id);
      }

      // Hierarchy context: parent summary (if any) and list of direct subgroups
      // filtered by visibility (private subgroups only visible to family members).
      const parent = group.parent_id
        ? await workingGroupDb.getWorkingGroupById(group.parent_id)
        : null;

      // Private subgroups show up only for people who are direct members of
      // that subgroup, or for AAO admins. Parent membership alone does not
      // unlock private subgroup visibility.
      const isAAOAdmin = user?.id ? await isWebUserAAOAdmin(user.id) : false;
      const allSubgroups = await workingGroupDb.listSubgroups(group.id);
      const visibleSubgroups: typeof allSubgroups = [];
      for (const sg of allSubgroups) {
        if (sg.status !== 'active') continue;
        if (!sg.is_private || isAAOAdmin) {
          visibleSubgroups.push(sg);
          continue;
        }
        if (user?.id && await workingGroupDb.isMember(sg.id, user.id)) {
          visibleSubgroups.push(sg);
        }
      }

      const subgroupSummaries = await Promise.all(
        visibleSubgroups.map(async sg => {
          const sgMembers = await workingGroupDb.getMembershipsByWorkingGroup(sg.id);
          return {
            id: sg.id,
            slug: sg.slug,
            name: sg.name,
            description: sg.description,
            committee_type: sg.committee_type,
            is_private: sg.is_private,
            slack_channel_url: sg.slack_channel_url,
            member_count: sgMembers.length,
          };
        })
      );

      const familyMemberCount = await workingGroupDb.countFamilyMembers(group.id);

      res.json({
        working_group: {
          ...group,
          member_count: memberships.length,
          memberships,
          parent: parent ? { id: parent.id, slug: parent.slug, name: parent.name } : null,
          subgroups: subgroupSummaries,
          family_member_count: familyMemberCount,
        },
        is_member: isMember,
        is_family_member: isFamilyMember,
      });
    } catch (error) {
      logger.error({ err: error }, 'Get working group error');
      res.status(500).json({
        error: 'Failed to get working group',
      });
    }
  });

  // GET /api/working-groups/:slug/posts - Get published posts for a working group
  publicApiRouter.get('/:slug/posts', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const pool = getPool();
      const user = req.user;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      let isMember = false;
      if (user?.id) {
        isMember = await workingGroupDb.isMember(group.id, user.id);
      }

      if (group.is_private) {
        if (!user?.id || !isMember) {
          return res.status(404).json({
            error: 'Working group not found',
            message: `No working group found with slug: ${slug}`,
          });
        }
      }

      // Aggregate from the group plus its subgroups the caller may see.
      // Private subgroups the caller isn't a member of are filtered out.
      const includeSubgroups = req.query.include_subgroups !== 'false';
      const isAAOAdmin = user?.id ? await isWebUserAAOAdmin(user.id) : false;
      const targetIds = includeSubgroups
        ? await workingGroupDb.getVisibleDescendantIds(group.id, user?.id ?? null, { isAdmin: isAAOAdmin })
        : [group.id];

      const result = await pool.query(
        `SELECT p.id, p.slug, p.content_type, p.title, p.subtitle, p.category, p.excerpt, p.content,
          p.external_url, p.external_site_name, p.author_name, p.author_title,
          p.featured_image_url, p.published_at, p.tags, p.is_members_only,
          p.working_group_id,
          wg.id as source_group_id, wg.slug as source_group_slug, wg.name as source_group_name
        FROM perspectives p
        JOIN working_groups wg ON wg.id = p.working_group_id
        WHERE p.working_group_id = ANY($1::uuid[]) AND p.status = 'published'
          AND (p.is_members_only = false OR $2 = true)
        ORDER BY p.published_at DESC NULLS LAST`,
        [targetIds, isMember]
      );

      const posts = result.rows.map(row => ({
        id: row.id,
        slug: row.slug,
        content_type: row.content_type,
        title: row.title,
        subtitle: row.subtitle,
        category: row.category,
        excerpt: row.excerpt,
        content: row.content,
        external_url: row.external_url,
        external_site_name: row.external_site_name,
        author_name: row.author_name,
        author_title: row.author_title,
        featured_image_url: row.featured_image_url,
        published_at: row.published_at,
        tags: row.tags,
        is_members_only: row.is_members_only,
        source_group: {
          id: row.source_group_id,
          slug: row.source_group_slug,
          name: row.source_group_name,
        },
      }));

      res.json({ posts });
    } catch (error) {
      logger.error({ err: error }, 'Get working group posts error');
      res.status(500).json({
        error: 'Failed to get posts',
      });
    }
  });

  // GET /api/working-groups/:slug/events - Get events for a committee
  publicApiRouter.get('/:slug/events', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const includeSubgroups = req.query.include_subgroups !== 'false';
      const targetIds = includeSubgroups
        ? await workingGroupDb.getVisibleDescendantIds(group.id, user?.id ?? null)
        : [group.id];

      const events = await eventsDb.getEventsByCommittee(targetIds, { includeUnpublished: false });

      res.json(events);
    } catch (error) {
      logger.error({ err: error }, 'Get committee events error');
      res.status(500).json({
        error: 'Failed to get events',
      });
    }
  });

  // POST /api/working-groups/:slug/join - Join a public working group
  publicApiRouter.post('/:slug/join', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;
      const result = await joinWorkingGroupService({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        slug,
      });
      res.status(201).json({ success: true, membership: result.membership });
    } catch (error) {
      if (error instanceof WorkingGroupMembershipError) {
        if (error.is('group_not_found')) {
          return res.status(404).json({
            error: 'Working group not found',
            message: `No working group found with slug: ${error.meta.slug}`,
          });
        }
        if (error.is('group_private')) {
          return res.status(403).json({
            error: 'Private group',
            message: 'This working group is private and requires an invitation to join',
          });
        }
        if (error.is('community_only_seat_blocked')) {
          const { userOrgId, workingGroupId, groupName, resourceType } = error.meta;
          return res.status(403).json({
            error: 'Contributor access required',
            message: 'Working group membership requires a contributor seat. Ask your org admin to upgrade your access.',
            can_request: !!userOrgId,
            request_url: userOrgId ? `/api/organizations/${userOrgId}/seat-requests` : undefined,
            request_body: userOrgId
              ? { resource_type: resourceType, resource_id: workingGroupId, resource_name: groupName }
              : undefined,
          });
        }
        if (error.is('already_member')) {
          return res.status(409).json({
            error: 'Already a member',
            message: 'You are already a member of this working group',
          });
        }
      }
      logger.error({ err: error }, 'Join working group error');
      res.status(500).json({ error: 'Failed to join working group' });
    }
  });

  // POST /api/working-groups/:slug/interest - Express interest in a committee (for launching groups)
  publicApiRouter.post('/:slug/interest', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const { interest_level: rawInterestLevel } = req.body;
      const user = req.user!;
      const result = await expressCommitteeInterestService({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        slug,
        interestLevel: rawInterestLevel,
      });
      res.status(201).json({
        success: true,
        message: `Thanks for your interest in ${result.groupName}! We'll let you know when it launches.`,
      });
    } catch (error) {
      if (error instanceof WorkingGroupMembershipError && error.is('group_not_found')) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${error.meta.slug}`,
        });
      }
      logger.error({ err: error }, 'Express committee interest error');
      res.status(500).json({ error: 'Failed to record interest' });
    }
  });

  // GET /api/working-groups/:slug/interest - Check if user has expressed interest
  publicApiRouter.get('/:slug/interest', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;
      const pool = getPool();

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      const result = await pool.query(
        `SELECT interest_level, created_at FROM committee_interest
         WHERE working_group_id = $1 AND workos_user_id = $2`,
        [group.id, user.id]
      );

      if (result.rows.length === 0) {
        return res.json({ has_interest: false });
      }

      res.json({
        has_interest: true,
        interest_level: result.rows[0].interest_level,
        registered_at: result.rows[0].created_at,
      });
    } catch (error) {
      logger.error({ err: error }, 'Check committee interest error');
      res.status(500).json({
        error: 'Failed to check interest',
      });
    }
  });

  // DELETE /api/working-groups/:slug/interest - Withdraw interest in a committee
  publicApiRouter.delete('/:slug/interest', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;
      const result = await withdrawCommitteeInterestService({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        slug,
      });
      res.json({
        success: true,
        message: `You have withdrawn your interest in ${result.groupName}.`,
      });
    } catch (error) {
      if (error instanceof WorkingGroupMembershipError) {
        if (error.is('group_not_found')) {
          return res.status(404).json({
            error: 'Committee not found',
            message: `No committee found with slug: ${error.meta.slug}`,
          });
        }
        if (error.is('no_interest_recorded')) {
          return res.status(404).json({
            error: 'No interest found',
            message: 'You have not expressed interest in this committee',
          });
        }
      }
      logger.error({ err: error }, 'Withdraw committee interest error');
      res.status(500).json({ error: 'Failed to withdraw interest' });
    }
  });

  // DELETE /api/working-groups/:slug/leave - Leave a working group
  publicApiRouter.delete('/:slug/leave', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const isLeader = group.leaders?.some(l => l.canonical_user_id === user.id) ?? false;
      if (isLeader) {
        return res.status(403).json({
          error: 'Cannot leave',
          message: 'As a leader, you must be replaced before leaving the group',
        });
      }

      const removed = await workingGroupDb.removeMembership(group.id, user.id);

      if (!removed) {
        return res.status(404).json({
          error: 'Not a member',
          message: 'You are not a member of this working group',
        });
      }

      invalidateMemberContextCache();
      invalidateWebAdminStatusCache(user.id);

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Leave working group error');
      res.status(500).json({
        error: 'Failed to leave working group',
      });
    }
  });

  // POST /api/working-groups/:slug/posts - Create a post in a working group (members)
  //
  // This is NOT the editorial review path. Posts created here are scoped
  // to the working group's internal feed (members-only by default) and
  // skip the pending_review → approve pipeline that applies to
  // Perspectives (via proposeContentForUser). The two surfaces are
  // distinct: Perspectives are public editorial; WG posts are
  // group-internal discussion.
  //
  // Invariants enforced below (see #2712):
  //   - Caller must be a member of the WG (403 otherwise).
  //   - Non-leaders cannot set is_members_only=false — if a non-lead
  //     could post publicly here, this endpoint would become a
  //     second-class editorial publish path. Leaders may opt to
  //     publish publicly within their own WG since they already have
  //     committee-lead authority over that WG's content.
  publicApiRouter.post('/:slug/posts', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const { title, content, content_type, category, excerpt, external_url, external_site_name, post_slug, is_members_only } = req.body;
      const user = req.user!;
      const result = await createWorkingGroupPostService({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        slug,
        title,
        postSlug: post_slug,
        content,
        contentType: content_type,
        category,
        excerpt,
        externalUrl: external_url,
        externalSiteName: external_site_name,
        isMembersOnly: is_members_only,
      });
      res.status(201).json({ post: result.post });
    } catch (error) {
      if (error instanceof WorkingGroupContentError) {
        if (error.is('group_not_found')) {
          return res.status(404).json({
            error: 'Working group not found',
            message: `No working group found with slug: ${error.meta.slug}`,
          });
        }
        if (error.is('not_member')) {
          return res.status(403).json({
            error: 'Not a member',
            message: 'You must be a member of this working group to post',
          });
        }
        if (error.is('leader_required_for_public_post')) {
          return res.status(403).json({
            error: 'Permission denied',
            message: 'Only committee leaders can create public (non-members-only) posts in this working group. Submit via the Perspectives flow for editorial review instead.',
          });
        }
        if (error.is('missing_required_fields')) {
          return res.status(400).json({ error: 'Missing required fields', message: 'Title and slug are required' });
        }
        if (error.is('invalid_post_slug')) {
          return res.status(400).json({
            error: 'Invalid slug',
            message: 'Slug must contain only lowercase letters, numbers, and hyphens',
          });
        }
        if (error.is('duplicate_post_slug')) {
          return res.status(409).json({
            error: 'Slug already exists',
            message: 'A post with this slug already exists in this working group',
          });
        }
      }
      logger.error({ err: error }, 'Create working group post error');
      res.status(500).json({ error: 'Failed to create post' });
    }
  });

  // PUT /api/working-groups/:slug/posts/:postId - Update own post (members)
  publicApiRouter.put('/:slug/posts/:postId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug, postId } = req.params;
      const { title, content, content_type, category, excerpt, external_url, external_site_name, post_slug, is_members_only } = req.body;
      const pool = getPool();
      const user = req.user!;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const isMember = await workingGroupDb.isMember(group.id, user.id);
      if (!isMember) {
        return res.status(403).json({
          error: 'Not a member',
          message: 'You must be a member of this working group',
        });
      }

      const existing = await pool.query(
        `SELECT * FROM perspectives WHERE id = $1 AND working_group_id = $2`,
        [postId, group.id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: 'Post not found',
          message: 'Post not found in this working group',
        });
      }

      const post = existing.rows[0];
      const isLeader = group.leaders?.some(l => l.canonical_user_id === user.id) ?? false;
      const isAuthor = post.author_user_id === user.id;

      if (!isAuthor && !isLeader) {
        return res.status(403).json({
          error: 'Not authorized',
          message: 'You can only edit your own posts',
        });
      }

      const finalMembersOnly = isLeader ? (is_members_only ?? post.is_members_only) : true;

      if (post_slug && post_slug !== post.slug) {
        const slugPattern = /^[a-z0-9-]+$/;
        if (!slugPattern.test(post_slug)) {
          return res.status(400).json({
            error: 'Invalid slug',
            message: 'Slug must contain only lowercase letters, numbers, and hyphens',
          });
        }
      }

      const result = await pool.query(
        `UPDATE perspectives SET
          slug = COALESCE($1, slug),
          content_type = COALESCE($2, content_type),
          title = COALESCE($3, title),
          content = $4,
          category = $5,
          excerpt = $6,
          external_url = $7,
          external_site_name = $8,
          is_members_only = $9,
          updated_at = NOW()
        WHERE id = $10 AND working_group_id = $11
        RETURNING *`,
        [
          post_slug || null,
          content_type || null,
          title || null,
          content ?? post.content,
          category ?? post.category,
          excerpt ?? post.excerpt,
          external_url ?? post.external_url,
          external_site_name ?? post.external_site_name,
          finalMembersOnly,
          postId,
          group.id,
        ]
      );

      res.json({ post: result.rows[0] });
    } catch (error) {
      logger.error({ err: error }, 'Update working group post error');
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return res.status(409).json({
          error: 'Slug already exists',
          message: 'A post with this slug already exists',
        });
      }
      res.status(500).json({
        error: 'Failed to update post',
      });
    }
  });

  // DELETE /api/working-groups/:slug/posts/:postId - Delete own post (members)
  publicApiRouter.delete('/:slug/posts/:postId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug, postId } = req.params;
      const pool = getPool();
      const user = req.user!;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const isMember = await workingGroupDb.isMember(group.id, user.id);
      if (!isMember) {
        return res.status(403).json({
          error: 'Not a member',
          message: 'You must be a member of this working group',
        });
      }

      const existing = await pool.query(
        `SELECT * FROM perspectives WHERE id = $1 AND working_group_id = $2`,
        [postId, group.id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: 'Post not found',
          message: 'Post not found in this working group',
        });
      }

      const post = existing.rows[0];
      const isLeader = group.leaders?.some(l => l.canonical_user_id === user.id) ?? false;
      const isAuthor = post.author_user_id === user.id;

      if (!isAuthor && !isLeader) {
        return res.status(403).json({
          error: 'Not authorized',
          message: 'You can only delete your own posts',
        });
      }

      await pool.query(
        `DELETE FROM perspectives WHERE id = $1 AND working_group_id = $2`,
        [postId, group.id]
      );

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Delete working group post error');
      res.status(500).json({
        error: 'Failed to delete post',
      });
    }
  });

  // POST /api/working-groups/:slug/fetch-url - Fetch URL metadata (members only)
  publicApiRouter.post('/:slug/fetch-url', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const { url } = req.body;
      const user = req.user!;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const isMember = await workingGroupDb.isMember(group.id, user.id);
      if (!isMember) {
        return res.status(403).json({
          error: 'Not a member',
          message: 'You must be a member of this working group',
        });
      }

      if (!url) {
        return res.status(400).json({
          error: 'URL required',
          message: 'Please provide a URL to fetch',
        });
      }

      const metadata = await fetchUrlMetadata(url);
      res.json(metadata);
    } catch (error) {
      logger.error({ err: error }, 'Fetch URL metadata error (member)');
      res.status(500).json({
        error: 'Failed to fetch URL',
      });
    }
  });

  // =========================================================================
  // COMMITTEE DOCUMENT ROUTES (/api/working-groups/:slug/documents)
  // =========================================================================

  // GET /api/working-groups/:slug/documents - Get documents for a committee (public)
  publicApiRouter.get('/:slug/documents', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      const documents = await workingGroupDb.getDocumentsByWorkingGroup(group.id);

      // Don't expose internal content to non-leaders
      const user = req.user;
      const isLeader = user && await workingGroupDb.isLeader(group.id, user.id);

      const publicDocuments = documents.map(doc => ({
        id: doc.id,
        title: doc.title,
        description: doc.description,
        document_url: doc.document_url,
        document_type: doc.document_type,
        display_order: doc.display_order,
        is_featured: doc.is_featured,
        last_modified_at: doc.last_modified_at,
        document_summary: doc.document_summary,
        summary_generated_at: doc.summary_generated_at,
        index_status: doc.index_status,
        created_at: doc.created_at,
        // Only include these for leaders
        ...(isLeader && {
          index_error: doc.index_error,
          last_indexed_at: doc.last_indexed_at,
        }),
      }));

      res.json({ documents: publicDocuments });
    } catch (error) {
      logger.error({ err: error }, 'Get committee documents error');
      res.status(500).json({
        error: 'Failed to get documents',
      });
    }
  });

  // GET /api/working-groups/:slug/activity - Get recent activity for a committee
  publicApiRouter.get('/:slug/activity', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      const activity = await workingGroupDb.getRecentActivity(group.id);
      res.json({ activity });
    } catch (error) {
      logger.error({ err: error }, 'Get committee activity error');
      res.status(500).json({
        error: 'Failed to get activity',
      });
    }
  });

  // GET /api/working-groups/:slug/summary - Get current committee summary
  publicApiRouter.get('/:slug/summary', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const summaryType = (req.query.type as string) || 'activity';

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      if (!['activity', 'overview', 'changes'].includes(summaryType)) {
        return res.status(400).json({
          error: 'Invalid summary type',
          message: 'Summary type must be: activity, overview, or changes',
        });
      }

      const summary = await workingGroupDb.getCurrentSummary(
        group.id,
        summaryType as 'activity' | 'overview' | 'changes'
      );

      res.json({ summary });
    } catch (error) {
      logger.error({ err: error }, 'Get committee summary error');
      res.status(500).json({
        error: 'Failed to get summary',
      });
    }
  });

  // POST /api/working-groups/:slug/documents - Add a document (members and leaders)
  publicApiRouter.post('/:slug/documents', requireAuth, requireWorkingGroupMember, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const { title, description, document_url, document_type, display_order, is_featured } = req.body;
      const user = req.user!;
      const result = await addCommitteeDocumentService({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        slug,
        title,
        documentUrl: document_url,
        description,
        documentType: document_type,
        displayOrder: display_order,
        isFeatured: is_featured,
      });
      res.status(201).json({ document: result.document });
    } catch (error) {
      if (error instanceof WorkingGroupContentError) {
        if (error.is('group_not_found')) {
          return res.status(404).json({
            error: 'Committee not found',
            message: `No committee found with slug: ${error.meta.slug}`,
          });
        }
        if (error.is('missing_required_fields')) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'Title and document_url are required',
          });
        }
        if (error.is('invalid_document_url')) {
          return res.status(400).json({
            error: 'Invalid document URL',
            message: 'Only Google Docs, Sheets, Drive URLs, and direct links to PDFs/PPTX/XLSX/DOCX from trusted hosts are supported',
          });
        }
        if (error.is('not_member')) {
          // requireWorkingGroupMember middleware blocks this in practice,
          // but the service still returns it for in-process callers.
          return res.status(403).json({ error: 'Not a member', message: 'Only committee members can add documents' });
        }
      }
      logger.error({ err: error }, 'Create committee document error');
      res.status(500).json({ error: 'Failed to create document' });
    }
  });

  // POST /api/working-groups/:slug/documents/upload - Upload a file as a document (members and leaders)
  // Multer middleware is wrapped to handle file validation errors in the route
  publicApiRouter.post('/:slug/documents/upload', requireAuth, requireWorkingGroupMember, (req: Request, res: Response, next: Function) => {
    documentUpload.single('file')(req, res, (err: any) => {
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
  }, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          error: 'Missing file',
          message: 'A PDF, PPTX, XLSX, or DOCX file is required',
        });
      }

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      const sanitizedFilename = file.originalname.replace(/[^\w.\-() ]/g, '_').slice(0, 200);
      const title = (req.body.title || sanitizedFilename.replace(/\.(pdf|pptx|xlsx|docx)$/i, '')).slice(0, 500);
      const description = req.body.description || null;
      const displayOrder = parseInt(req.body.display_order) || 0;
      const isFeatured = req.body.is_featured === 'true';

      const document = await workingGroupDb.createDocument({
        working_group_id: group.id,
        title,
        description,
        file_data: file.buffer,
        file_name: sanitizedFilename,
        file_mime_type: file.mimetype,
        display_order: displayOrder,
        is_featured: isFeatured,
        added_by_user_id: user.id,
      });

      logger.info({ documentId: document.id, groupSlug: slug, userId: user.id, fileName: file.originalname }, 'Committee document uploaded');

      // Notify the working group's Slack channel
      if (group.slack_channel_id && isSlackConfigured()) {
        const userName = user.firstName && user.lastName
          ? `${user.firstName} ${user.lastName}`
          : user.email || 'A working group leader';
        const appUrl = process.env.APP_URL || 'https://agenticadvertising.org';
        const groupUrl = `${appUrl}/working-groups/${slug}`;
        const safeTitle = title.replace(/[|<>]/g, '-');
        const safeDescription = description ? description.replace(/[|<>]/g, '-') : '';

        sendChannelMessage(group.slack_channel_id, {
          text: `📄 New file uploaded to ${group.name}: ${title}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text' as const,
                text: '📄 New File Uploaded',
                emoji: true,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn' as const,
                text: `*${safeTitle}* (${file.originalname.replace(/[|<>]/g, '-')})${safeDescription ? `\n${safeDescription}` : ''}`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn' as const,
                text: `Added by ${userName} · <${groupUrl}|View all ${group.name} resources>`,
              },
            },
          ],
        }).catch(err => {
          logger.warn({ err, groupSlug: slug, documentId: document.id }, 'Failed to send Slack notification for uploaded document');
        });
      }

      const { file_data: _fd, last_content: _lc, ...documentMeta } = document;
      res.status(201).json({ document: documentMeta });

      // Index immediately so Addie can reference the document right away
      reindexDocument(document.id)
        .then(() => refreshWorkingGroupDocs())
        .catch(err => logger.warn({ err, documentId: document.id }, 'Background indexing after file upload failed'));
    } catch (error) {
      logger.error({ err: error }, 'Upload committee document error');
      res.status(500).json({
        error: 'Failed to upload document',
      });
    }
  });

  // GET /api/working-groups/:slug/documents/:documentId/file - Download uploaded file
  publicApiRouter.get('/:slug/documents/:documentId/file', async (req: Request, res: Response) => {
    try {
      const { slug, documentId } = req.params;

      if (!isUuid(documentId)) {
        return res.status(400).json({ error: 'Invalid document ID' });
      }

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({ error: 'Committee not found' });
      }

      const fileData = await workingGroupDb.getDocumentFileData(documentId, group.id);
      if (!fileData) {
        return res.status(404).json({ error: 'No file data available' });
      }

      const SAFE_SERVE_TYPES: Record<string, string> = {
        'application/pdf': 'application/pdf',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
      res.setHeader('Content-Type', SAFE_SERVE_TYPES[fileData.file_mime_type] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileData.file_name)}"`);
      res.setHeader('Content-Length', fileData.file_data.length);
      res.send(fileData.file_data);
    } catch (error) {
      logger.error({ err: error }, 'Serve committee document file error');
      res.status(500).json({ error: 'Failed to serve file' });
    }
  });

  // PUT /api/working-groups/:slug/documents/:documentId - Update a document (members and leaders)
  publicApiRouter.put('/:slug/documents/:documentId', requireAuth, requireWorkingGroupMember, async (req: Request, res: Response) => {
    try {
      const { slug, documentId } = req.params;
      const { title, description, document_url, document_type, display_order, is_featured } = req.body;
      const user = req.user!;
      const result = await updateCommitteeDocumentService({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        slug,
        documentId,
        title,
        description,
        documentUrl: document_url,
        documentType: document_type,
        displayOrder: display_order,
        isFeatured: is_featured,
      });
      res.json({ document: result.document });
    } catch (error) {
      if (error instanceof WorkingGroupContentError) {
        if (error.is('invalid_document_id')) {
          return res.status(400).json({ error: 'Invalid document ID', message: 'Document ID must be a valid UUID' });
        }
        if (error.is('group_not_found')) {
          return res.status(404).json({
            error: 'Committee not found',
            message: `No committee found with slug: ${error.meta.slug}`,
          });
        }
        if (error.is('document_not_found')) {
          return res.status(404).json({ error: 'Document not found', message: 'Document not found in this committee' });
        }
        if (error.is('invalid_document_url')) {
          return res.status(400).json({
            error: 'Invalid document URL',
            message: 'Only Google Docs, Sheets, Drive URLs, and direct links to PDFs/PPTX/XLSX/DOCX from trusted hosts are supported',
          });
        }
        if (error.is('not_member')) {
          return res.status(403).json({ error: 'Not a member', message: 'Only committee members can update documents' });
        }
      }
      logger.error({ err: error }, 'Update committee document error');
      res.status(500).json({ error: 'Failed to update document' });
    }
  });

  // POST /api/working-groups/:slug/documents/:documentId/reindex - Trigger reindex (members and leaders)
  publicApiRouter.post('/:slug/documents/:documentId/reindex', requireAuth, requireWorkingGroupMember, async (req: Request, res: Response) => {
    try {
      const { slug, documentId } = req.params;
      const user = req.user!;

      // Rate limit check to prevent API cost abuse
      if (!checkReindexRateLimit(user.id)) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: 'Too many reindex requests. Please wait a minute before trying again.',
        });
      }

      if (!isUuid(documentId)) {
        return res.status(400).json({
          error: 'Invalid document ID',
          message: 'Document ID must be a valid UUID',
        });
      }

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      const existingDoc = await workingGroupDb.getDocumentById(documentId);
      if (!existingDoc || existingDoc.working_group_id !== group.id) {
        return res.status(404).json({
          error: 'Document not found',
          message: 'Document not found in this committee',
        });
      }

      const result = await reindexDocument(documentId);

      if (!result.success) {
        return res.status(500).json({
          error: 'Reindex failed',
          message: result.error,
        });
      }

      // Refresh in-memory search index so Addie sees updated content
      await refreshWorkingGroupDocs();

      // Fetch the updated document
      const updatedDoc = await workingGroupDb.getDocumentById(documentId);

      logger.info({ documentId, groupSlug: slug }, 'Committee document reindexed');

      res.json({
        success: true,
        document: updatedDoc,
      });
    } catch (error) {
      logger.error({ err: error }, 'Reindex committee document error');
      res.status(500).json({
        error: 'Failed to reindex document',
      });
    }
  });

  // DELETE /api/working-groups/:slug/documents/:documentId - Delete a document (leaders only)
  publicApiRouter.delete('/:slug/documents/:documentId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, documentId } = req.params;
      const user = req.user!;
      await deleteCommitteeDocumentService({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        slug,
        documentId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof WorkingGroupContentError) {
        if (error.is('invalid_document_id')) {
          return res.status(400).json({ error: 'Invalid document ID', message: 'Document ID must be a valid UUID' });
        }
        if (error.is('group_not_found')) {
          return res.status(404).json({
            error: 'Committee not found',
            message: `No committee found with slug: ${error.meta.slug}`,
          });
        }
        if (error.is('document_not_found')) {
          return res.status(404).json({ error: 'Document not found', message: 'Document not found in this committee' });
        }
        if (error.is('not_leader')) {
          return res.status(403).json({ error: 'Not a leader', message: 'Only committee leaders can delete documents' });
        }
      }
      logger.error({ err: error }, 'Delete committee document error');
      res.status(500).json({ error: 'Failed to delete document' });
    }
  });

  // GET /api/working-groups/assets/:assetId — Serve an extracted document asset (image)
  publicApiRouter.get('/assets/:assetId', async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params;

      if (!isUuid(assetId)) {
        return res.status(400).send('Invalid asset ID');
      }

      const asset = await workingGroupDb.getDocumentAssetData(assetId);
      if (!asset) {
        return res.status(404).send('Asset not found');
      }

      const SAFE_SERVE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      if (!SAFE_SERVE_TYPES.has(asset.mime_type)) {
        return res.status(415).send('Unsupported media type');
      }

      res.set({
        'Content-Type': asset.mime_type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=86400',
      });
      return res.send(asset.asset_data);
    } catch (error) {
      logger.error({ err: error, assetId: req.params.assetId }, 'Failed to serve document asset');
      res.status(500).send('Internal error');
    }
  });

  // GET /api/working-groups/:slug/documents/:documentId/assets — List assets for a document
  publicApiRouter.get('/:slug/documents/:documentId/assets', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { documentId } = req.params;

      if (!isUuid(documentId)) {
        return res.status(400).json({ error: 'Invalid document ID' });
      }

      const assets = await workingGroupDb.getDocumentAssets(documentId);

      res.json(assets.map(a => ({
        ...a,
        url: `/api/working-groups/assets/${a.id}`,
      })));
    } catch (error) {
      logger.error({ err: error }, 'Failed to list document assets');
      res.status(500).json({ error: 'Failed to list assets' });
    }
  });

  // =========================================================================
  // LEADER API ROUTES (/api/working-groups/:slug/manage/*)
  // =========================================================================

  // GET /api/working-groups/:slug/manage/posts - List all posts (including drafts) for leaders
  publicApiRouter.get('/:slug/manage/posts', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const pool = getPool();

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const result = await pool.query(
        `SELECT id, slug, content_type, title, subtitle, category, excerpt, content,
          external_url, external_site_name, author_name, author_title,
          author_user_id, featured_image_url, status, published_at, display_order, tags,
          created_at, updated_at
        FROM perspectives
        WHERE working_group_id = $1
        ORDER BY display_order ASC, published_at DESC NULLS LAST, created_at DESC`,
        [group.id]
      );

      res.json({ posts: result.rows });
    } catch (error) {
      logger.error({ err: error }, 'List working group leader posts error');
      res.status(500).json({
        error: 'Failed to list posts',
      });
    }
  });

  // GET /api/working-groups/:slug/manage/posts/:postId - Get single post for editing
  publicApiRouter.get('/:slug/manage/posts/:postId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, postId } = req.params;
      const pool = getPool();

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const result = await pool.query(
        `SELECT * FROM perspectives WHERE id = $1 AND working_group_id = $2`,
        [postId, group.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Post not found',
          message: 'Post not found in this working group',
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error }, 'Get working group post error');
      res.status(500).json({
        error: 'Failed to get post',
      });
    }
  });

  // POST /api/working-groups/:slug/manage/posts - Create post as leader (with draft support)
  publicApiRouter.post('/:slug/manage/posts', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const {
        post_slug, content_type, title, subtitle, category, excerpt, content,
        external_url, external_site_name, author_name, author_title,
        featured_image_url, status, display_order, tags, is_members_only
      } = req.body;
      const pool = getPool();
      const user = req.user!;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      if (!title || !post_slug) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'Title and slug are required',
        });
      }

      const slugPattern = /^[a-z0-9-]+$/;
      if (!slugPattern.test(post_slug)) {
        return res.status(400).json({
          error: 'Invalid slug',
          message: 'Slug must contain only lowercase letters, numbers, and hyphens',
        });
      }

      if (content_type === 'link' && !external_url) {
        return res.status(400).json({
          error: 'Missing external URL',
          message: 'External URL is required for link type posts',
        });
      }

      const authorNameFinal = author_name || (user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.email);

      const result = await pool.query(
        `INSERT INTO perspectives (
          working_group_id, slug, content_type, title, subtitle, category, excerpt, content,
          external_url, external_site_name, author_name, author_title, author_user_id,
          featured_image_url, status, display_order, tags, published_at, is_members_only
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING *`,
        [
          group.id,
          post_slug,
          content_type || 'article',
          title,
          subtitle || null,
          category || null,
          excerpt || null,
          content || null,
          external_url || null,
          external_site_name || null,
          authorNameFinal,
          author_title || null,
          user.id,
          featured_image_url || null,
          status || 'draft',
          display_order || 0,
          tags || null,
          status === 'published' ? new Date() : null,
          is_members_only || false,
        ]
      );

      const createdPost = result.rows[0];

      // Send Slack notification to the working group's channel
      if (status === 'published') {
        notifyPublishedPost({
          slackChannelId: group.slack_channel_id ?? undefined,
          workingGroupName: group.name,
          workingGroupSlug: slug,
          postTitle: title,
          postSlug: post_slug,
          authorName: authorNameFinal,
          contentType: content_type || 'article',
          excerpt: excerpt || undefined,
          externalUrl: external_url || undefined,
          category: category || undefined,
          isMembersOnly: is_members_only || false,
        }).catch(err => {
          logger.warn({ err }, 'Failed to send Slack channel notification for working group post');
        });
      }

      res.status(201).json(createdPost);
    } catch (error) {
      logger.error({ err: error }, 'Create working group leader post error');
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return res.status(409).json({
          error: 'Slug already exists',
          message: 'A post with this slug already exists',
        });
      }
      res.status(500).json({
        error: 'Failed to create post',
      });
    }
  });

  // PUT /api/working-groups/:slug/manage/posts/:postId - Update post as leader
  publicApiRouter.put('/:slug/manage/posts/:postId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, postId } = req.params;
      const {
        post_slug, content_type, title, subtitle, category, excerpt, content,
        external_url, external_site_name, author_name, author_title,
        featured_image_url, status, display_order, tags, is_members_only
      } = req.body;
      const pool = getPool();

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const existing = await pool.query(
        `SELECT * FROM perspectives WHERE id = $1 AND working_group_id = $2`,
        [postId, group.id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: 'Post not found',
          message: 'Post not found in this working group',
        });
      }

      if (post_slug) {
        const slugPattern = /^[a-z0-9-]+$/;
        if (!slugPattern.test(post_slug)) {
          return res.status(400).json({
            error: 'Invalid slug',
            message: 'Slug must contain only lowercase letters, numbers, and hyphens',
          });
        }
      }

      const wasPublished = existing.rows[0].status === 'published';
      const willBePublished = status === 'published';
      const publishedAt = willBePublished && !wasPublished
        ? new Date()
        : existing.rows[0].published_at;

      const result = await pool.query(
        `UPDATE perspectives SET
          slug = COALESCE($1, slug),
          content_type = COALESCE($2, content_type),
          title = COALESCE($3, title),
          subtitle = $4,
          category = $5,
          excerpt = $6,
          content = $7,
          external_url = $8,
          external_site_name = $9,
          author_name = COALESCE($10, author_name),
          author_title = $11,
          featured_image_url = $12,
          status = COALESCE($13, status),
          display_order = COALESCE($14, display_order),
          tags = $15,
          published_at = $16,
          is_members_only = $17,
          updated_at = NOW()
        WHERE id = $18 AND working_group_id = $19
        RETURNING *`,
        [
          post_slug || null,
          content_type || null,
          title || null,
          subtitle || null,
          category || null,
          excerpt || null,
          content || null,
          external_url || null,
          external_site_name || null,
          author_name || null,
          author_title || null,
          featured_image_url || null,
          status || null,
          display_order ?? null,
          tags || null,
          publishedAt,
          is_members_only ?? false,
          postId,
          group.id,
        ]
      );

      const updatedPost = result.rows[0];

      // Send Slack notification when post transitions to published
      if (willBePublished && !wasPublished) {
        notifyPublishedPost({
          slackChannelId: group.slack_channel_id ?? undefined,
          workingGroupName: group.name,
          workingGroupSlug: slug,
          postTitle: updatedPost.title,
          postSlug: updatedPost.slug,
          authorName: updatedPost.author_name || 'Unknown',
          contentType: updatedPost.content_type || 'article',
          excerpt: updatedPost.excerpt || undefined,
          externalUrl: updatedPost.external_url || undefined,
          category: updatedPost.category || undefined,
          isMembersOnly: updatedPost.is_members_only || false,
        }).catch(err => {
          logger.warn({ err }, 'Failed to send Slack channel notification for working group post');
        });
      }

      res.json(updatedPost);
    } catch (error) {
      logger.error({ err: error }, 'Update working group post error');
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return res.status(409).json({
          error: 'Slug already exists',
          message: 'A post with this slug already exists',
        });
      }
      res.status(500).json({
        error: 'Failed to update post',
      });
    }
  });

  // DELETE /api/working-groups/:slug/manage/posts/:postId - Delete post as leader
  publicApiRouter.delete('/:slug/manage/posts/:postId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, postId } = req.params;
      const pool = getPool();

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      const result = await pool.query(
        `DELETE FROM perspectives WHERE id = $1 AND working_group_id = $2 RETURNING id`,
        [postId, group.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Post not found',
          message: 'Post not found in this working group',
        });
      }

      res.json({ success: true, deleted: postId });
    } catch (error) {
      logger.error({ err: error }, 'Delete working group post error');
      res.status(500).json({
        error: 'Failed to delete post',
      });
    }
  });

  // POST /api/working-groups/:slug/manage/fetch-url - Fetch URL metadata (for link posts)
  publicApiRouter.post('/:slug/manage/fetch-url', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { url } = req.body;

      if (!url) {
        return res.status(400).json({
          error: 'URL required',
          message: 'Please provide a URL to fetch',
        });
      }

      const metadata = await fetchUrlMetadata(url);
      res.json(metadata);
    } catch (error) {
      logger.error({ err: error }, 'Fetch URL metadata error (working group)');
      res.status(500).json({
        error: 'Failed to fetch URL',
      });
    }
  });

  // =========================================================================
  // COMMITTEE EVENT MANAGEMENT (Leader-only)
  // =========================================================================

  // GET /api/working-groups/:slug/manage/events - List committee events for leaders
  publicApiRouter.get('/:slug/manage/events', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      // Get events linked to this committee (including drafts for leaders)
      const { upcoming, past } = await eventsDb.getEventsByCommittee(group.id, { includeUnpublished: true });

      // Combine and sort by start_time descending
      const allEvents = [...upcoming, ...past].sort((a, b) =>
        new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
      );

      res.json({ events: allEvents });
    } catch (error) {
      logger.error({ err: error }, 'Get committee events error');
      res.status(500).json({
        error: 'Failed to get events',
      });
    }
  });

  // GET /api/working-groups/:slug/manage/events/:eventId - Get single event for editing
  publicApiRouter.get('/:slug/manage/events/:eventId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, eventId } = req.params;

      // Validate UUID format
      if (!isUuid(eventId)) {
        return res.status(400).json({
          error: 'Invalid event ID',
          message: 'Event ID must be a valid UUID',
        });
      }

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      const event = await eventsDb.getEventById(eventId);

      if (!event) {
        return res.status(404).json({
          error: 'Event not found',
          message: `No event found with id: ${eventId}`,
        });
      }

      // Verify event is linked to this committee
      const isLinked = await eventsDb.isCommitteeLinkedToEvent(eventId, group.id);
      if (!isLinked) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'This event is not linked to your committee',
        });
      }

      res.json(event);
    } catch (error) {
      logger.error({ err: error }, 'Get committee event error');
      res.status(500).json({
        error: 'Failed to get event',
      });
    }
  });

  // POST /api/working-groups/:slug/manage/events - Create event as committee leader
  publicApiRouter.post('/:slug/manage/events', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;
      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      const {
        title,
        description,
        slug: eventSlug,
        start_time,
        end_time,
        event_format,
        event_type,
        status,
        venue_name,
        venue_address,
        venue_city,
        venue_state,
        virtual_meeting_url,
        max_attendees,
      } = req.body;

      if (!title || !eventSlug) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'Title and slug are required',
        });
      }

      // Validate slug format (lowercase alphanumeric with hyphens)
      if (!/^[a-z0-9-]+$/.test(eventSlug)) {
        return res.status(400).json({
          error: 'Invalid slug format',
          message: 'Slug must contain only lowercase letters, numbers, and hyphens',
        });
      }

      // Validate date range if both provided
      if (start_time && end_time && new Date(end_time) <= new Date(start_time)) {
        return res.status(400).json({
          error: 'Invalid date range',
          message: 'End time must be after start time',
        });
      }

      // Validate max attendees if provided
      if (max_attendees !== undefined && max_attendees !== null && max_attendees < 1) {
        return res.status(400).json({
          error: 'Invalid max attendees',
          message: 'Max attendees must be a positive number',
        });
      }

      // Default venue_city from chapter region if this is a chapter
      let defaultCity = venue_city;
      if (!defaultCity && group.committee_type === 'chapter' && group.region) {
        defaultCity = group.region.replace(' Chapter', '').replace(' chapter', '').trim();
      }

      const event = await eventsDb.createEvent({
        title,
        description: description || undefined,
        slug: eventSlug,
        start_time: start_time ? new Date(start_time) : new Date(),
        end_time: end_time ? new Date(end_time) : undefined,
        event_format: event_format || 'in_person',
        event_type: event_type || 'meetup',
        status: status || 'draft',
        venue_name: venue_name || undefined,
        venue_address: venue_address || undefined,
        venue_city: defaultCity || undefined,
        venue_state: venue_state || undefined,
        virtual_url: virtual_meeting_url || undefined,
        max_attendees: max_attendees || undefined,
        created_by_user_id: user.id,
      });

      // Link the event to this committee as the host
      await eventsDb.linkEventToCommittee(event.id, group.id, 'host', user.id);

      res.status(201).json(event);
    } catch (error) {
      logger.error({ err: error }, 'Create committee event error');
      res.status(500).json({
        error: 'Failed to create event',
      });
    }
  });

  // PUT /api/working-groups/:slug/manage/events/:eventId - Update event as committee leader
  publicApiRouter.put('/:slug/manage/events/:eventId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, eventId } = req.params;

      // Validate UUID format
      if (!isUuid(eventId)) {
        return res.status(400).json({
          error: 'Invalid event ID',
          message: 'Event ID must be a valid UUID',
        });
      }

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      // Verify event is linked to this committee
      const isLinked = await eventsDb.isCommitteeLinkedToEvent(eventId, group.id);
      if (!isLinked) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'This event is not linked to your committee',
        });
      }

      const existingEvent = await eventsDb.getEventById(eventId);
      if (!existingEvent) {
        return res.status(404).json({
          error: 'Event not found',
          message: `No event found with id: ${eventId}`,
        });
      }

      const {
        title,
        description,
        start_time,
        end_time,
        event_format,
        event_type,
        status,
        venue_name,
        venue_address,
        venue_city,
        venue_state,
        virtual_meeting_url,
        max_attendees,
      } = req.body;

      const updatedEvent = await eventsDb.updateEvent(eventId, {
        title,
        description,
        start_time: start_time ? new Date(start_time) : undefined,
        end_time: end_time ? new Date(end_time) : undefined,
        event_format,
        event_type,
        status,
        venue_name,
        venue_address,
        venue_city,
        venue_state,
        virtual_url: virtual_meeting_url,
        max_attendees,
      });

      res.json(updatedEvent);
    } catch (error) {
      logger.error({ err: error }, 'Update committee event error');
      res.status(500).json({
        error: 'Failed to update event',
      });
    }
  });

  // DELETE /api/working-groups/:slug/manage/events/:eventId - Delete event as committee leader
  publicApiRouter.delete('/:slug/manage/events/:eventId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, eventId } = req.params;

      // Validate UUID format
      if (!isUuid(eventId)) {
        return res.status(400).json({
          error: 'Invalid event ID',
          message: 'Event ID must be a valid UUID',
        });
      }

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      // Verify event is linked to this committee
      const isLinked = await eventsDb.isCommitteeLinkedToEvent(eventId, group.id);
      if (!isLinked) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'This event is not linked to your committee',
        });
      }

      const existingEvent = await eventsDb.getEventById(eventId);
      if (!existingEvent) {
        return res.status(404).json({
          error: 'Event not found',
          message: `No event found with id: ${eventId}`,
        });
      }

      // Check if other committees are linked to this event
      const linkedCommittees = await eventsDb.getCommitteesForEvent(eventId);

      // Always unlink from this committee
      await eventsDb.unlinkEventFromCommittee(eventId, group.id);

      // Only delete the event if this was the only linked committee
      if (linkedCommittees.length <= 1) {
        await eventsDb.deleteEvent(eventId);
        res.json({ success: true, deleted: eventId });
      } else {
        res.json({
          success: true,
          unlinked: eventId,
          message: 'Event unlinked from your committee but preserved for other linked committees',
        });
      }
    } catch (error) {
      logger.error({ err: error }, 'Delete committee event error');
      res.status(500).json({
        error: 'Failed to delete event',
      });
    }
  });

  // =========================================================================
  // USER API ROUTES (/api/me/working-groups)
  // =========================================================================

  // GET /api/me/working-groups - Get current user's working group memberships
  userApiRouter.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const groups = await workingGroupDb.getWorkingGroupsForUser(user.id);
      res.json({ working_groups: groups });
    } catch (error) {
      logger.error({ err: error }, 'Get user working groups error');
      res.status(500).json({
        error: 'Failed to get working groups',
      });
    }
  });

  // GET /api/me/working-groups/leading - Get committees the current user leads
  userApiRouter.get('/leading', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const committees = await workingGroupDb.getCommitteesLedByUser(user.id);
      res.json({ committees });
    } catch (error) {
      logger.error({ err: error }, 'Get user led committees error');
      res.status(500).json({
        error: 'Failed to get led committees',
      });
    }
  });

  // GET /api/me/working-groups/interests - Get current user's council interest signups
  userApiRouter.get('/interests', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const interests = await workingGroupDb.getCouncilInterestsForUser(user.id);
      res.json(interests);
    } catch (error) {
      logger.error({ err: error }, 'Get user council interests error');
      res.status(500).json({
        error: 'Failed to get council interests',
      });
    }
  });

  return { adminApiRouter, publicApiRouter, userApiRouter };
}
