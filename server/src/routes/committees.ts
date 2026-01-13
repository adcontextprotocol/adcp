/**
 * Committee routes module
 *
 * Handles all API routes for committees (working groups, councils, chapters, governance)
 * including admin, public, and leader-only endpoints.
 */

import { Router, Request, Response } from "express";
import { WorkOS } from "@workos-inc/node";
import { getPool } from "../db/client.js";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin, optionalAuth, createRequireWorkingGroupLeader } from "../middleware/auth.js";
import { WorkingGroupDatabase } from "../db/working-group-db.js";
import { eventsDb } from "../db/events-db.js";
import { invalidateMemberContextCache } from "../addie/index.js";
import { syncWorkingGroupMembersFromSlack, syncAllWorkingGroupMembersFromSlack } from "../slack/sync.js";
import { notifyPublishedPost } from "../notifications/slack.js";
import { decodeHtmlEntities } from "../utils/html-entities.js";
import { reindexDocument } from "../addie/jobs/committee-document-indexer.js";
import { createChannel, setChannelPurpose } from "../slack/client.js";

const logger = createLogger("committee-routes");

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Allowed document URL patterns (whitelist approach to prevent SSRF)
const ALLOWED_DOCUMENT_DOMAINS = [
  'docs.google.com',
  'drive.google.com',
  'sheets.google.com',
];

function isAllowedDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Must be HTTPS
    if (parsed.protocol !== 'https:') {
      return false;
    }
    // Must be an allowed domain
    return ALLOWED_DOCUMENT_DOMAINS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: errorMessage,
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/working-groups - Create working group
  adminApiRouter.post('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { name, slug, description, slack_channel_url, is_private, status, display_order,
              leader_user_ids, committee_type, region } = req.body;

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
        leader_user_ids, committee_type, region: finalRegion
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
      logger.error({ err: error }, 'Create working group error:');
      res.status(500).json({
        error: 'Failed to create working group',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      const group = await workingGroupDb.updateWorkingGroup(id, updates);

      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with id ${id}`
        });
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
      logger.error({ err: error }, 'Update working group error:');
      res.status(500).json({
        error: 'Failed to update working group',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/admin/working-groups/:id - Delete working group
  adminApiRouter.delete('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deleted = await workingGroupDb.deleteWorkingGroup(id);

      if (!deleted) {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with id ${id}`
        });
      }

      res.json({ success: true, deleted: id });
    } catch (error) {
      logger.error({ err: error }, 'Delete working group error:');
      res.status(500).json({
        error: 'Failed to delete working group',
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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

      res.status(201).json(membership);
    } catch (error) {
      logger.error({ err: error }, 'Add working group member error:');
      res.status(500).json({
        error: 'Failed to add member',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Remove working group member error:');
      res.status(500).json({
        error: 'Failed to remove member',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
      if (user?.id) {
        isMember = await workingGroupDb.isMember(group.id, user.id);
      }

      res.json({
        working_group: {
          ...group,
          member_count: memberships.length,
          memberships,
        },
        is_member: isMember,
      });
    } catch (error) {
      logger.error({ err: error }, 'Get working group error');
      res.status(500).json({
        error: 'Failed to get working group',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      const result = await pool.query(
        `SELECT id, slug, content_type, title, subtitle, category, excerpt, content,
          external_url, external_site_name, author_name, author_title,
          featured_image_url, published_at, tags, is_members_only
        FROM perspectives
        WHERE working_group_id = $1 AND status = 'published'
          AND (is_members_only = false OR $2 = true)
        ORDER BY published_at DESC NULLS LAST`,
        [group.id, isMember]
      );

      res.json({ posts: result.rows });
    } catch (error) {
      logger.error({ err: error }, 'Get working group posts error');
      res.status(500).json({
        error: 'Failed to get posts',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/working-groups/:slug/events - Get events for a committee
  publicApiRouter.get('/:slug/events', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      // Get events linked to this committee (published only for public view)
      const events = await eventsDb.getEventsByCommittee(group.id, { includeUnpublished: false });

      res.json(events);
    } catch (error) {
      logger.error({ err: error }, 'Get committee events error');
      res.status(500).json({
        error: 'Failed to get events',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/working-groups/:slug/join - Join a public working group
  publicApiRouter.post('/:slug/join', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Working group not found',
          message: `No working group found with slug: ${slug}`,
        });
      }

      if (group.is_private) {
        return res.status(403).json({
          error: 'Private group',
          message: 'This working group is private and requires an invitation to join',
        });
      }

      const existingMembership = await workingGroupDb.getMembership(group.id, user.id);
      if (existingMembership && existingMembership.status === 'active') {
        return res.status(409).json({
          error: 'Already a member',
          message: 'You are already a member of this working group',
        });
      }

      let orgId: string | undefined;
      let orgName: string | undefined;
      if (workos) {
        try {
          const memberships = await workos.userManagement.listOrganizationMemberships({
            userId: user.id,
          });
          if (memberships.data.length > 0) {
            const org = await workos.organizations.getOrganization(memberships.data[0].organizationId);
            orgId = org.id;
            orgName = org.name;
          }
        } catch {
          // Ignore org fetch errors
        }
      }

      const membership = await workingGroupDb.addMembership({
        working_group_id: group.id,
        workos_user_id: user.id,
        user_email: user.email,
        user_name: user.firstName && user.lastName
          ? `${user.firstName} ${user.lastName}`
          : user.email,
        workos_organization_id: orgId,
        user_org_name: orgName,
        added_by_user_id: user.id,
      });

      invalidateMemberContextCache();

      res.status(201).json({ success: true, membership });
    } catch (error) {
      logger.error({ err: error }, 'Join working group error');
      res.status(500).json({
        error: 'Failed to join working group',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/working-groups/:slug/interest - Express interest in a committee (for launching groups)
  publicApiRouter.post('/:slug/interest', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const { interest_level: rawInterestLevel } = req.body;
      const user = req.user!;
      const pool = getPool();

      // Validate interest level
      const validInterestLevels = ['participant', 'leader'] as const;
      const interest_level = validInterestLevels.includes(rawInterestLevel)
        ? rawInterestLevel
        : 'participant';

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);

      if (!group || group.status !== 'active') {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      // Get user's org info if available
      let orgId: string | undefined;
      let orgName: string | undefined;
      if (workos) {
        try {
          const memberships = await workos.userManagement.listOrganizationMemberships({
            userId: user.id,
          });
          if (memberships.data.length > 0) {
            const org = await workos.organizations.getOrganization(memberships.data[0].organizationId);
            orgId = org.id;
            orgName = org.name;
          }
        } catch {
          // Ignore org fetch errors
        }
      }

      const userName = user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.email;

      // Upsert the interest record
      await pool.query(
        `INSERT INTO committee_interest (
          working_group_id, workos_user_id, user_email, user_name,
          workos_organization_id, user_org_name, interest_level
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (working_group_id, workos_user_id) DO UPDATE SET
          interest_level = COALESCE(EXCLUDED.interest_level, committee_interest.interest_level),
          user_email = EXCLUDED.user_email,
          user_name = EXCLUDED.user_name,
          user_org_name = EXCLUDED.user_org_name`,
        [
          group.id,
          user.id,
          user.email,
          userName,
          orgId || null,
          orgName || null,
          interest_level,
        ]
      );

      logger.info(
        { workingGroupId: group.id, userId: user.id, interestLevel: interest_level },
        'User expressed interest in committee'
      );

      res.status(201).json({
        success: true,
        message: `Thanks for your interest in ${group.name}! We'll let you know when it launches.`,
      });
    } catch (error) {
      logger.error({ err: error }, 'Express committee interest error');
      res.status(500).json({
        error: 'Failed to record interest',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/working-groups/:slug/interest - Withdraw interest in a committee
  publicApiRouter.delete('/:slug/interest', requireAuth, async (req: Request, res: Response) => {
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
        `DELETE FROM committee_interest
         WHERE working_group_id = $1 AND workos_user_id = $2
         RETURNING id`,
        [group.id, user.id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: 'No interest found',
          message: 'You have not expressed interest in this committee',
        });
      }

      logger.info(
        { workingGroupId: group.id, userId: user.id },
        'User withdrew interest in committee'
      );

      res.json({
        success: true,
        message: `You have withdrawn your interest in ${group.name}.`,
      });
    } catch (error) {
      logger.error({ err: error }, 'Withdraw committee interest error');
      res.status(500).json({
        error: 'Failed to withdraw interest',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Leave working group error');
      res.status(500).json({
        error: 'Failed to leave working group',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/working-groups/:slug/posts - Create a post in a working group (members)
  publicApiRouter.post('/:slug/posts', requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
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
          message: 'You must be a member of this working group to post',
        });
      }

      const isLeader = group.leaders?.some(l => l.canonical_user_id === user.id) ?? false;
      const finalMembersOnly = isLeader ? (is_members_only ?? true) : true;

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

      const authorName = user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.email;

      const result = await pool.query(
        `INSERT INTO perspectives (
          working_group_id, slug, content_type, title, content, category, excerpt,
          external_url, external_site_name, author_name, author_user_id,
          status, published_at, is_members_only
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'published', NOW(), $12)
        RETURNING *`,
        [
          group.id,
          post_slug,
          content_type || 'article',
          title,
          content || null,
          category || null,
          excerpt || null,
          external_url || null,
          external_site_name || null,
          authorName,
          user.id,
          finalMembersOnly,
        ]
      );

      // Send Slack notification to the working group's channel
      notifyPublishedPost({
        slackChannelId: group.slack_channel_id ?? undefined,
        workingGroupName: group.name,
        workingGroupSlug: slug,
        postTitle: title,
        postSlug: post_slug,
        authorName,
        contentType: content_type || 'article',
        excerpt: excerpt || undefined,
        externalUrl: external_url || undefined,
        category: category || undefined,
        isMembersOnly: finalMembersOnly,
      }).catch(err => {
        logger.warn({ err }, 'Failed to send Slack channel notification for working group post');
      });

      res.status(201).json({ post: result.rows[0] });
    } catch (error) {
      logger.error({ err: error }, 'Create working group post error');
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return res.status(409).json({
          error: 'Slug already exists',
          message: 'A post with this slug already exists in this working group',
        });
      }
      res.status(500).json({
        error: 'Failed to create post',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/working-groups/:slug/documents - Add a document (leaders only)
  publicApiRouter.post('/:slug/documents', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const { title, description, document_url, document_type, display_order, is_featured } = req.body;
      const user = req.user!;

      const group = await workingGroupDb.getWorkingGroupBySlug(slug);
      if (!group) {
        return res.status(404).json({
          error: 'Committee not found',
          message: `No committee found with slug: ${slug}`,
        });
      }

      if (!title || !document_url) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'Title and document_url are required',
        });
      }

      // Strict URL validation to prevent SSRF - only allow trusted domains
      if (!isAllowedDocumentUrl(document_url)) {
        return res.status(400).json({
          error: 'Invalid document URL',
          message: 'Only Google Docs, Sheets, and Drive URLs are supported',
        });
      }

      const document = await workingGroupDb.createDocument({
        working_group_id: group.id,
        title,
        description,
        document_url,
        document_type,
        display_order: display_order ?? 0,
        is_featured: is_featured ?? false,
        added_by_user_id: user.id,
      });

      logger.info({ documentId: document.id, groupSlug: slug, userId: user.id }, 'Committee document created');

      res.status(201).json({ document });
    } catch (error) {
      logger.error({ err: error }, 'Create committee document error');
      res.status(500).json({
        error: 'Failed to create document',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/working-groups/:slug/documents/:documentId - Update a document (leaders only)
  publicApiRouter.put('/:slug/documents/:documentId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, documentId } = req.params;
      const { title, description, document_url, document_type, display_order, is_featured } = req.body;

      if (!UUID_REGEX.test(documentId)) {
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

      // Validate URL if provided - strict validation to prevent SSRF
      if (document_url && !isAllowedDocumentUrl(document_url)) {
        return res.status(400).json({
          error: 'Invalid document URL',
          message: 'Only Google Docs, Sheets, and Drive URLs are supported',
        });
      }

      const document = await workingGroupDb.updateDocument(documentId, {
        title,
        description,
        document_url,
        document_type,
        display_order,
        is_featured,
      });

      res.json({ document });
    } catch (error) {
      logger.error({ err: error }, 'Update committee document error');
      res.status(500).json({
        error: 'Failed to update document',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/working-groups/:slug/documents/:documentId/reindex - Trigger reindex (leaders only)
  publicApiRouter.post('/:slug/documents/:documentId/reindex', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
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

      if (!UUID_REGEX.test(documentId)) {
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/working-groups/:slug/documents/:documentId - Delete a document (leaders only)
  publicApiRouter.delete('/:slug/documents/:documentId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, documentId } = req.params;

      if (!UUID_REGEX.test(documentId)) {
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

      await workingGroupDb.deleteDocument(documentId);

      logger.info({ documentId, groupSlug: slug }, 'Committee document deleted');

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Delete committee document error');
      res.status(500).json({
        error: 'Failed to delete document',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/working-groups/:slug/manage/events/:eventId - Get single event for editing
  publicApiRouter.get('/:slug/manage/events/:eventId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, eventId } = req.params;

      // Validate UUID format
      if (!UUID_REGEX.test(eventId)) {
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/working-groups/:slug/manage/events/:eventId - Update event as committee leader
  publicApiRouter.put('/:slug/manage/events/:eventId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, eventId } = req.params;

      // Validate UUID format
      if (!UUID_REGEX.test(eventId)) {
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/working-groups/:slug/manage/events/:eventId - Delete event as committee leader
  publicApiRouter.delete('/:slug/manage/events/:eventId', requireAuth, requireWorkingGroupLeader, async (req: Request, res: Response) => {
    try {
      const { slug, eventId } = req.params;

      // Validate UUID format
      if (!UUID_REGEX.test(eventId)) {
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/me/working-groups/interests - Get current user's council interest signups
  userApiRouter.get('/interests', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const pool = getPool();

      const result = await pool.query(
        `SELECT ci.interest_level, ci.created_at, wg.name as committee_name, wg.slug, wg.committee_type
         FROM committee_interest ci
         JOIN working_groups wg ON wg.id = ci.working_group_id
         WHERE ci.workos_user_id = $1
         ORDER BY ci.created_at DESC`,
        [user.id]
      );

      res.json(result.rows);
    } catch (error) {
      logger.error({ err: error }, 'Get user council interests error');
      res.status(500).json({
        error: 'Failed to get council interests',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return { adminApiRouter, publicApiRouter, userApiRouter };
}
