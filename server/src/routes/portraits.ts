/**
 * Portrait routes module
 *
 * Public serving, member self-service, and admin management of
 * illustrated member portraits.
 */

import { Router } from 'express';
import multer from 'multer';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin, isDevModeEnabled, DEV_USERS } from '../middleware/auth.js';
import { OrganizationDatabase } from '../db/organization-db.js';
import { MemberDatabase } from '../db/member-db.js';
import { query as dbQuery } from '../db/client.js';
import * as portraitDb from '../db/portrait-db.js';
import { generatePortrait, VIBE_OPTIONS } from '../services/portrait-generator.js';

const logger = createLogger('portrait-routes');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG and PNG files are accepted'));
    }
  },
});

const MAX_MONTHLY_GENERATIONS = 3;

export interface PortraitRoutesConfig {
  memberDb: MemberDatabase;
  orgDb: OrganizationDatabase;
  invalidateMemberContextCache: () => void;
}

/**
 * Resolve the member profile ID for the authenticated user.
 * Handles both production (WorkOS) and dev mode.
 */
async function resolveProfileId(
  req: any,
  memberDb: MemberDatabase,
  orgDb: OrganizationDatabase,
): Promise<string | null> {
  const user = req.user;
  if (!user) return null;

  const requestedOrgId = req.query.org as string | undefined;

  // Dev mode: look up profile from the seeded dev org
  if (isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id)) {
    const devOrgId = requestedOrgId?.startsWith('org_dev_') ? requestedOrgId : 'org_dev_company_001';
    const profile = await memberDb.getProfileByOrgId(devOrgId);
    return profile?.id || null;
  }

  const memberships = user.organizationMemberships || [];
  for (const m of memberships) {
    const orgId = m.organization?.id || m.organizationId;
    if (requestedOrgId && orgId !== requestedOrgId) continue;
    const profile = await memberDb.getProfileByOrgId(orgId);
    if (profile) return profile.id;
  }

  return null;
}

/**
 * Check if the user has a paid subscription.
 */
async function isPaidMember(
  req: any,
  orgDb: OrganizationDatabase,
): Promise<boolean> {
  if (isDevModeEnabled()) return true;

  const user = req.user;
  const requestedOrgId = req.query.org as string | undefined;
  const memberships = user?.organizationMemberships || [];

  for (const m of memberships) {
    const orgId = m.organization?.id || m.organizationId;
    if (requestedOrgId && orgId !== requestedOrgId) continue;
    if (await orgDb.hasActiveSubscription(orgId)) return true;
  }

  return false;
}

// =============================================================================
// PUBLIC ROUTES — portrait serving
// =============================================================================

export function createPublicPortraitRouter(): Router {
  const router = Router();

  // GET /api/portraits/:id.png — serve portrait image
  router.get('/:id.png', async (req, res) => {
    try {
      const data = await portraitDb.getPortraitData(req.params.id);
      if (!data) {
        return res.status(404).send('Portrait not found');
      }

      // If we have binary data, serve it directly
      if (data.portrait_data) {
        res.set({
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        return res.send(data.portrait_data);
      }

      // Otherwise redirect to the static image URL
      res.redirect(301, data.image_url);
    } catch (err) {
      logger.error({ err, id: req.params.id }, 'Failed to serve portrait');
      res.status(500).send('Internal error');
    }
  });

  // GET /api/portraits/builders — public list of builders with portraits
  router.get('/builders', async (_req, res) => {
    try {
      const builders = await portraitDb.getPublicBuilders();
      res.json(builders.map(b => ({
        name: b.display_name,
        firstName: b.display_name.split(' ')[0],
        slug: b.slug,
        portraitUrl: `/api/portraits/${b.portrait_id}.png`,
        tagline: b.tagline,
      })));
    } catch (err) {
      logger.error({ err }, 'Failed to list builders');
      res.status(500).json({ error: 'Failed to load builders' });
    }
  });

  return router;
}

// =============================================================================
// MEMBER ROUTES — self-service portrait management
// =============================================================================

export function createPortraitRouter(config: PortraitRoutesConfig): Router {
  const { memberDb, orgDb, invalidateMemberContextCache } = config;
  const router = Router();

  // GET / — get current portrait metadata
  router.get('/', requireAuth, async (req, res) => {
    try {
      const profileId = await resolveProfileId(req, memberDb, orgDb);
      if (!profileId) {
        return res.status(404).json({ error: 'No member profile found' });
      }

      const portrait = await portraitDb.getActivePortrait(profileId);
      const pending = await portraitDb.getLatestGenerated(profileId);
      const monthlyCount = await portraitDb.countMonthlyGenerations(profileId);

      res.json({
        portrait: portrait || null,
        pending: pending || null,
        generationsThisMonth: monthlyCount,
        maxMonthlyGenerations: MAX_MONTHLY_GENERATIONS,
        vibeOptions: Object.keys(VIBE_OPTIONS),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get portrait');
      res.status(500).json({ error: 'Failed to load portrait' });
    }
  });

  // POST /generate — upload photo + vibe, generate portrait
  router.post('/generate', requireAuth, upload.single('photo'), async (req, res) => {
    try {
      const profileId = await resolveProfileId(req, memberDb, orgDb);
      if (!profileId) {
        return res.status(404).json({ error: 'No member profile found' });
      }

      if (!await isPaidMember(req, orgDb)) {
        return res.status(402).json({ error: 'Active subscription required for portrait generation' });
      }

      const monthlyCount = await portraitDb.countMonthlyGenerations(profileId);
      if (monthlyCount >= MAX_MONTHLY_GENERATIONS) {
        return res.status(429).json({
          error: 'Monthly generation limit reached',
          generationsThisMonth: monthlyCount,
          maxMonthlyGenerations: MAX_MONTHLY_GENERATIONS,
        });
      }

      const vibe = (req.body.vibe as string) || 'casual';
      const photoBuffer = req.file?.buffer;
      const photoMimeType = req.file?.mimetype;

      const result = await generatePortrait({
        photoBuffer,
        photoMimeType,
        vibe,
        palette: 'amber',
      });

      const portrait = await portraitDb.createPortrait({
        member_profile_id: profileId,
        image_url: '', // Will be set after we know the ID
        portrait_data: result.imageBuffer,
        prompt_used: result.promptUsed,
        vibe,
        palette: 'amber',
        status: 'generated',
      });

      // Update image_url to the serving path
      await dbQuery(
        `UPDATE member_portraits SET image_url = $1 WHERE id = $2`,
        [`/api/portraits/${portrait.id}.png`, portrait.id]
      );

      logger.info({ profileId, portraitId: portrait.id, vibe }, 'Portrait generated');

      res.json({
        id: portrait.id,
        image_url: `/api/portraits/${portrait.id}.png`,
        status: 'generated',
        vibe,
      });
    } catch (err) {
      logger.error({ err }, 'Portrait generation failed');
      res.status(500).json({ error: 'Portrait generation failed' });
    }
  });

  // POST /approve — accept the latest generated portrait
  router.post('/approve', requireAuth, async (req, res) => {
    try {
      const profileId = await resolveProfileId(req, memberDb, orgDb);
      if (!profileId) {
        return res.status(404).json({ error: 'No member profile found' });
      }

      const portraitId = req.body.portraitId as string;
      if (!portraitId) {
        return res.status(400).json({ error: 'portraitId required' });
      }

      const portrait = await portraitDb.approvePortrait(portraitId, profileId);
      if (!portrait) {
        return res.status(404).json({ error: 'Portrait not found' });
      }

      invalidateMemberContextCache();
      logger.info({ profileId, portraitId }, 'Portrait approved');

      res.json({ portrait });
    } catch (err) {
      logger.error({ err }, 'Portrait approval failed');
      res.status(500).json({ error: 'Failed to approve portrait' });
    }
  });

  // DELETE / — remove portrait from profile
  router.delete('/', requireAuth, async (req, res) => {
    try {
      const profileId = await resolveProfileId(req, memberDb, orgDb);
      if (!profileId) {
        return res.status(404).json({ error: 'No member profile found' });
      }

      await portraitDb.removeFromProfile(profileId);
      invalidateMemberContextCache();
      logger.info({ profileId }, 'Portrait removed from profile');

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Failed to remove portrait');
      res.status(500).json({ error: 'Failed to remove portrait' });
    }
  });

  return router;
}

// =============================================================================
// ADMIN ROUTES
// =============================================================================

export function createAdminPortraitRouter(): Router {
  const router = Router();

  // GET / — list all portraits
  router.get('/', requireAuth, requireAdmin, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      const portraits = await portraitDb.listPortraits({ status, limit, offset });
      res.json({ portraits });
    } catch (err) {
      logger.error({ err }, 'Failed to list portraits');
      res.status(500).json({ error: 'Failed to list portraits' });
    }
  });

  // GET /map — user_id -> portrait_id mapping (lightweight)
  router.get('/map', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const map = await portraitDb.getUserPortraitMap();
      res.json(map);
    } catch (err) {
      logger.error({ err }, 'Failed to get portrait map');
      res.status(500).json({ error: 'Failed to get portrait map' });
    }
  });

  // DELETE /:id — remove inappropriate portrait
  router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const portrait = await portraitDb.getPortraitById(req.params.id);
      if (!portrait) {
        return res.status(404).json({ error: 'Portrait not found' });
      }

      // Remove from profile if it's the active one
      await portraitDb.removeFromProfile(portrait.member_profile_id);
      await portraitDb.rejectPortrait(req.params.id);

      logger.info({ portraitId: req.params.id }, 'Portrait removed by admin');
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete portrait');
      res.status(500).json({ error: 'Failed to delete portrait' });
    }
  });

  return router;
}
