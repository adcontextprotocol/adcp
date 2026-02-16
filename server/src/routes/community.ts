import { Router } from "express";
import { createLogger } from "../logger.js";
import { requireAuth } from "../middleware/auth.js";
import { CommunityDatabase, type CommunityProfile } from "../db/community-db.js";
import { MemberDatabase } from "../db/member-db.js";
import { OrganizationDatabase } from "../db/organization-db.js";
import { SlackDatabase } from "../db/slack-db.js";
import { sendDirectMessage } from "../slack/client.js";
import { query } from "../db/client.js";
import { VALID_MEMBER_OFFERINGS, type MemberOffering } from "../types.js";

const logger = createLogger("community-routes");

export interface CommunityRoutesConfig {
  communityDb: CommunityDatabase;
  slackDb?: SlackDatabase;
  memberDb?: MemberDatabase;
  orgDb?: OrganizationDatabase;
  invalidateMemberContextCache?: () => void;
}

/**
 * Create community routes.
 * Returns publicRouter (mounted at /api/community) and userRouter (mounted at /api/me).
 */
export function createCommunityRouters(config: CommunityRoutesConfig) {
  const { communityDb, slackDb, memberDb, orgDb, invalidateMemberContextCache } = config;
  const publicRouter = Router();
  const userRouter = Router();

  // =====================================================
  // PUBLIC ROUTES (/api/community/*)
  // =====================================================

  // GET /api/community/expertise -- distinct expertise tags for filter dropdown
  publicRouter.get('/expertise', requireAuth, async (_req, res) => {
    try {
      const tags = await communityDb.getDistinctExpertise();
      res.json({ tags });
    } catch (error) {
      logger.error({ error }, 'Failed to get expertise tags');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/community/people -- list/search people (auth required)
  publicRouter.get('/people', requireAuth, async (req, res) => {
    try {
      const { people, total } = await communityDb.listPeople({
        search: req.query.search as string | undefined,
        expertise: req.query.expertise as string | undefined,
        city: req.query.city as string | undefined,
        open_to_coffee_chat: req.query.coffee_chat === 'true' ? true : undefined,
        limit: Math.min(parseInt(req.query.limit as string) || 50, 100),
        offset: Math.max(0, parseInt(req.query.offset as string) || 0),
        viewer_user_id: req.user!.id,
      });

      res.json({ people, total });
    } catch (error) {
      logger.error({ error }, 'Failed to list people');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/community/people/:slug -- get person detail (auth required)
  publicRouter.get('/people/:slug', requireAuth, async (req, res) => {
    try {
      const person = await communityDb.getPersonBySlug(req.params.slug, req.user!.id);
      if (!person) {
        return res.status(404).json({ error: 'Person not found' });
      }
      res.json(person);
    } catch (error) {
      logger.error({ error, slug: req.params.slug }, 'Failed to get person');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/community/connections -- send connection request
  publicRouter.post('/connections', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { recipient_user_id, message } = req.body;

      if (!recipient_user_id || typeof recipient_user_id !== 'string') {
        return res.status(400).json({ error: 'recipient_user_id must be a string' });
      }

      if (message && (typeof message !== 'string' || message.length > 500)) {
        return res.status(400).json({ error: 'Message must be 500 characters or fewer' });
      }

      if (recipient_user_id === user.id) {
        return res.status(400).json({ error: 'Cannot connect with yourself' });
      }

      // Check if connection already exists
      const existing = await communityDb.getConnectionStatus(user.id, recipient_user_id);
      if (existing) {
        return res.status(409).json({ error: 'Connection already exists', status: existing.status });
      }

      const connection = await communityDb.requestConnection(user.id, recipient_user_id, message);

      // Notify recipient via Slack DM (fire-and-forget)
      if (slackDb) {
        notifyConnectionRequest(slackDb, user, recipient_user_id, message).catch(
          err => logger.error({ err }, 'Failed to send connection Slack DM')
        );
      }

      res.status(201).json(connection);
    } catch (error) {
      logger.error({ error }, 'Failed to create connection');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/community/connections/:id -- accept/decline
  publicRouter.put('/connections/:id', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { status } = req.body;

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid connection ID' });
      }

      if (!status || !['accepted', 'declined'].includes(status)) {
        return res.status(400).json({ error: 'status must be "accepted" or "declined"' });
      }

      const connection = await communityDb.respondToConnection(req.params.id, user.id, status);
      if (!connection) {
        return res.status(404).json({ error: 'Connection not found or not pending' });
      }

      // Award points and check badge thresholds on acceptance
      if (status === 'accepted') {
        await Promise.all([
          communityDb.awardPoints(connection.requester_user_id, 'connection_made', 10, connection.id, 'connection'),
          communityDb.awardPoints(connection.recipient_user_id, 'connection_made', 10, connection.id, 'connection'),
        ]);
        // Check connection-count badges for both users (fire-and-forget)
        Promise.all([
          communityDb.checkAndAwardBadges(connection.requester_user_id, 'connection'),
          communityDb.checkAndAwardBadges(connection.recipient_user_id, 'connection'),
        ]).catch(err => logger.error({ err }, 'Badge check failed'));

        // Notify requester via Slack DM (fire-and-forget)
        if (slackDb) {
          notifyConnectionAccepted(slackDb, user, connection.requester_user_id).catch(
            err => logger.error({ err }, 'Failed to send connection acceptance Slack DM')
          );
        }
      }

      res.json(connection);
    } catch (error) {
      logger.error({ error }, 'Failed to respond to connection');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // USER ROUTES (/api/me/*)
  // =====================================================

  // PUT /api/me/community-profile -- update community profile fields
  userRouter.put('/community-profile', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const allowedFields = [
        'slug', 'headline', 'bio', 'avatar_url', 'expertise', 'interests',
        'linkedin_url', 'twitter_url', 'github_username', 'is_public', 'open_to_coffee_chat', 'open_to_intros',
        'city',
      ];

      const updates: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      // Validate boolean fields
      for (const boolField of ['is_public', 'open_to_coffee_chat', 'open_to_intros'] as const) {
        if (updates[boolField] !== undefined && typeof updates[boolField] !== 'boolean') {
          return res.status(400).json({ error: `${boolField} must be a boolean` });
        }
      }

      // Validate array fields
      for (const arrField of ['expertise', 'interests'] as const) {
        if (updates[arrField] !== undefined) {
          if (!Array.isArray(updates[arrField]) || !(updates[arrField] as unknown[]).every(e => typeof e === 'string')) {
            return res.status(400).json({ error: `${arrField} must be an array of strings` });
          }
          if ((updates[arrField] as string[]).length > 20) {
            return res.status(400).json({ error: `Maximum 20 ${arrField} tags allowed` });
          }
        }
      }

      // Validate string length limits
      if (updates.headline && typeof updates.headline === 'string' && updates.headline.length > 255) {
        return res.status(400).json({ error: 'Headline must be 255 characters or fewer' });
      }
      if (updates.bio && typeof updates.bio === 'string' && updates.bio.length > 5000) {
        return res.status(400).json({ error: 'Bio must be 5000 characters or fewer' });
      }
      if (updates.city && typeof updates.city === 'string' && updates.city.length > 100) {
        return res.status(400).json({ error: 'City must be 100 characters or fewer' });
      }

      // Validate slug format if provided
      if (updates.slug) {
        const slug = (updates.slug as string).toLowerCase().trim();
        if (slug.length < 2 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
          return res.status(400).json({ error: 'Slug must be 2+ characters, lowercase alphanumeric and hyphens' });
        }
        updates.slug = slug;
      }

      // Validate URL fields are HTTP(S) only
      for (const urlField of ['avatar_url', 'linkedin_url', 'twitter_url'] as const) {
        const value = updates[urlField];
        if (value && typeof value === 'string') {
          try {
            const parsed = new URL(value);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              return res.status(400).json({ error: `${urlField} must be an HTTP or HTTPS URL` });
            }
          } catch {
            return res.status(400).json({ error: `${urlField} must be a valid URL` });
          }
        }
      }

      // Validate GitHub username format
      if (updates.github_username && typeof updates.github_username === 'string') {
        if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(updates.github_username) || updates.github_username.length > 39) {
          return res.status(400).json({ error: 'Invalid GitHub username' });
        }
      }

      // Validate member-directory-only fields (synced to member_profiles for individual accounts)
      if (req.body.offerings !== undefined) {
        if (!Array.isArray(req.body.offerings) ||
            !req.body.offerings.every((o: unknown) => typeof o === 'string' && VALID_MEMBER_OFFERINGS.includes(o as any))) {
          return res.status(400).json({ error: 'Invalid offerings' });
        }
      }
      if (req.body.contact_email !== undefined && typeof req.body.contact_email === 'string' && req.body.contact_email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.contact_email)) {
          return res.status(400).json({ error: 'Invalid contact email' });
        }
      }
      if (req.body.contact_phone !== undefined && typeof req.body.contact_phone === 'string' && req.body.contact_phone) {
        if (req.body.contact_phone.length > 30 || !/^[+\d\s()./-]+$/.test(req.body.contact_phone)) {
          return res.status(400).json({ error: 'Invalid contact phone' });
        }
      }
      if (req.body.contact_website !== undefined && typeof req.body.contact_website === 'string' && req.body.contact_website) {
        try {
          const parsed = new URL(req.body.contact_website);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return res.status(400).json({ error: 'contact_website must be an HTTP or HTTPS URL' });
          }
        } catch {
          return res.status(400).json({ error: 'contact_website must be a valid URL' });
        }
      }

      // Check if github_username is being set for the first time (for one-time points award)
      const awardGithubPoints = updates.github_username
        ? !(await communityDb.getProfile(user.id))?.github_username
        : false;

      const profile = await communityDb.updateProfile(user.id, updates);
      if (!profile) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Award one-time points for linking GitHub
      if (awardGithubPoints && profile.github_username) {
        await communityDb.awardPoints(user.id, 'github_linked', 10, user.id, 'user');
      }

      // Check profile completeness badge (fire-and-forget)
      communityDb.checkAndAwardBadges(user.id, 'profile').catch(
        err => logger.error({ err }, 'Badge check failed')
      );

      // For individual accounts, sync community profile → member_profiles
      if (memberDb && orgDb) {
        const memberFields: MemberDirectoryFields = {
          offerings: Array.isArray(req.body.offerings) ? req.body.offerings as MemberOffering[] : undefined,
          contact_email: typeof req.body.contact_email === 'string' ? req.body.contact_email : undefined,
          contact_website: typeof req.body.contact_website === 'string' ? req.body.contact_website : undefined,
          contact_phone: typeof req.body.contact_phone === 'string' ? req.body.contact_phone : undefined,
        };
        try {
          await syncIndividualMemberProfile(user.id, profile, memberFields, memberDb, orgDb, invalidateMemberContextCache);
        } catch (err) {
          logger.error({ err }, 'Member profile sync failed');
        }
      }

      res.json(profile);
    } catch (error: any) {
      if (error?.constraint === 'users_slug_key') {
        return res.status(409).json({ error: 'Slug already taken' });
      }
      logger.error({ error }, 'Failed to update community profile');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/me/connections -- accepted connections
  userRouter.get('/connections', requireAuth, async (req, res) => {
    try {
      const connections = await communityDb.listConnections(req.user!.id);
      res.json({ connections });
    } catch (error) {
      logger.error({ error }, 'Failed to list connections');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/me/connections/pending -- incoming pending requests
  userRouter.get('/connections/pending', requireAuth, async (req, res) => {
    try {
      const connections = await communityDb.listPendingConnections(req.user!.id);
      res.json({ connections });
    } catch (error) {
      logger.error({ error }, 'Failed to list pending connections');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/me/connections/sent -- outgoing pending requests
  userRouter.get('/connections/sent', requireAuth, async (req, res) => {
    try {
      const connections = await communityDb.listSentConnections(req.user!.id);
      res.json({ connections });
    } catch (error) {
      logger.error({ error }, 'Failed to list sent connections');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/me/community/hub -- aggregated hub data
  userRouter.get('/community/hub', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;

      // Award daily visit points (fire-and-forget)
      communityDb.awardDailyVisit(userId).catch(err => {
        logger.error({ err, userId }, 'Failed to award daily visit points');
      });

      const hubData = await communityDb.getHubData(userId);
      res.json(hubData);
    } catch (error) {
      logger.error({ error }, 'Failed to get hub data');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return { publicRouter, userRouter };
}

async function notifyConnectionRequest(
  slackDb: SlackDatabase,
  requester: { id: string; firstName?: string; lastName?: string },
  recipientUserId: string,
  message?: string,
): Promise<void> {
  const mapping = await slackDb.getByWorkosUserId(recipientUserId);
  if (!mapping?.slack_user_id) return;

  const name = [requester.firstName, requester.lastName].filter(Boolean).join(' ') || 'Someone';
  const text = message
    ? `${name} sent you a connection request on the AgenticAdvertising.org community: "${message}"\n\nView your requests: https://agenticadvertising.org/community/connections`
    : `${name} sent you a connection request on the AgenticAdvertising.org community.\n\nView your requests: https://agenticadvertising.org/community/connections`;

  await sendDirectMessage(mapping.slack_user_id, { text });
}

async function notifyConnectionAccepted(
  slackDb: SlackDatabase,
  acceptor: { id: string; firstName?: string; lastName?: string },
  requesterUserId: string,
): Promise<void> {
  const mapping = await slackDb.getByWorkosUserId(requesterUserId);
  if (!mapping?.slack_user_id) return;

  const name = [acceptor.firstName, acceptor.lastName].filter(Boolean).join(' ') || 'Someone';
  const text = `${name} accepted your connection request on the AgenticAdvertising.org community!\n\nView your connections: https://agenticadvertising.org/community/connections`;

  await sendDirectMessage(mapping.slack_user_id, { text });
}

/**
 * For individual (personal) accounts, sync community profile fields to member_profiles
 * so the member directory listing stays up to date from a single profile form.
 */
interface MemberDirectoryFields {
  offerings?: MemberOffering[];
  contact_email?: string;
  contact_website?: string;
  contact_phone?: string;
}

async function syncIndividualMemberProfile(
  userId: string,
  communityProfile: CommunityProfile,
  memberFields: MemberDirectoryFields,
  memberDb: MemberDatabase,
  orgDb: OrganizationDatabase,
  invalidateMemberContextCache?: () => void,
): Promise<void> {
  // Look up user's org
  const userRow = await query<{ primary_organization_id: string | null; first_name: string; last_name: string }>(
    'SELECT primary_organization_id, first_name, last_name FROM users WHERE workos_user_id = $1',
    [userId]
  );
  const user = userRow.rows[0];
  if (!user?.primary_organization_id) return;

  // Only sync for personal/individual orgs
  const org = await orgDb.getOrganization(user.primary_organization_id);
  if (!org?.is_personal) return;

  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Member';

  // Build mapped fields for member_profiles
  const memberUpdates: Record<string, unknown> = {
    display_name: displayName,
    tagline: communityProfile.headline || null,
    description: communityProfile.bio || null,
    logo_url: communityProfile.avatar_url || null,
    linkedin_url: communityProfile.linkedin_url || null,
    twitter_url: communityProfile.twitter_url || null,
  };

  if (memberFields.contact_email !== undefined) memberUpdates.contact_email = memberFields.contact_email;
  if (memberFields.contact_website !== undefined) memberUpdates.contact_website = memberFields.contact_website;
  if (memberFields.contact_phone !== undefined) memberUpdates.contact_phone = memberFields.contact_phone;

  // Only sync if a member profile already exists — don't auto-create
  const existingProfile = await memberDb.getProfileByOrgId(user.primary_organization_id);
  if (!existingProfile) return;

  // Merge offerings: the form only edits individual-relevant offerings (consulting, other).
  // Preserve any other offerings the existing profile has (e.g. data_provider).
  if (memberFields.offerings !== undefined) {
    const individualOfferings: MemberOffering[] = ['consulting', 'other'];
    const preserved = (existingProfile.offerings || []).filter(
      (o: MemberOffering) => !individualOfferings.includes(o)
    );
    memberUpdates.offerings = [...preserved, ...memberFields.offerings];
  }

  await memberDb.updateProfileByOrgId(user.primary_organization_id, memberUpdates);
  invalidateMemberContextCache?.();
}
