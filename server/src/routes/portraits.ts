/**
 * Portrait routes module
 *
 * Public serving, member self-service, and admin management of
 * illustrated member portraits. Portraits belong to users.
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
  orgDb: OrganizationDatabase;
  memberDb: MemberDatabase;
  invalidateMemberContextCache: () => void;
}

/**
 * Resolve the user ID for portrait operations.
 */
function resolveUserId(req: any): string | null {
  const user = req.user;
  if (!user) return null;
  return user.id;
}

/**
 * Check if the user belongs to a member organization.
 * Checks both subscription status and member profile existence,
 * since founding/invoice members may not have a Stripe subscription.
 */
async function isPaidMember(
  req: any,
  orgDb: OrganizationDatabase,
  memberDb: MemberDatabase,
): Promise<boolean> {
  if (isDevModeEnabled()) return true;

  const user = req.user;
  const requestedOrgId = req.query.org as string | undefined;
  const memberships = user?.organizationMemberships || [];

  for (const m of memberships) {
    const orgId = m.organization?.id || m.organizationId;
    if (requestedOrgId && orgId !== requestedOrgId) continue;
    if (await orgDb.hasActiveSubscription(orgId)) return true;
    // Founding/invoice members may not have a subscription record
    const profile = await memberDb.getProfileByOrgId(orgId);
    if (profile) return true;
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
  const { orgDb, memberDb, invalidateMemberContextCache } = config;
  const router = Router();

  // GET / — get current portrait metadata
  router.get('/', requireAuth, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const portrait = await portraitDb.getActivePortrait(userId);
      const pending = await portraitDb.getLatestGenerated(userId);
      const monthlyCount = await portraitDb.countMonthlyGenerations(userId);

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
      const userId = resolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      if (!await isPaidMember(req, orgDb, memberDb)) {
        return res.status(402).json({ error: 'Active subscription required for portrait generation' });
      }

      const monthlyCount = await portraitDb.countMonthlyGenerations(userId);
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
        user_id: userId,
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

      logger.info({ userId, portraitId: portrait.id, vibe }, 'Portrait generated');

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
      const userId = resolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const portraitId = req.body.portraitId as string;
      if (!portraitId) {
        return res.status(400).json({ error: 'portraitId required' });
      }

      const portrait = await portraitDb.approvePortrait(portraitId, userId);
      if (!portrait) {
        return res.status(404).json({ error: 'Portrait not found' });
      }

      invalidateMemberContextCache();
      logger.info({ userId, portraitId }, 'Portrait approved');

      res.json({ portrait });
    } catch (err) {
      logger.error({ err }, 'Portrait approval failed');
      res.status(500).json({ error: 'Failed to approve portrait' });
    }
  });

  // DELETE / — remove portrait from user
  router.delete('/', requireAuth, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      await portraitDb.removeFromUser(userId);
      invalidateMemberContextCache();
      logger.info({ userId }, 'Portrait removed');

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

      // Only clear from user if this is their active portrait
      if (portrait.user_id) {
        const user = await portraitDb.getActivePortraitId(portrait.user_id);
        if (user === req.params.id) {
          await portraitDb.removeFromUser(portrait.user_id);
        }
      }
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
