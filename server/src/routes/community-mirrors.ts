/**
 * Community-mirror catalog lifecycle API (#2176).
 *
 * AAO publishes catalog-only adagents.json mirrors for platforms that have not
 * adopted AdCP (Meta, TikTok, …). These mirrors carry catalog content
 * (formats/properties/placements) and an empty `authorized_agents: []` — there
 * is no sales agent to authorize. This router makes them first-class:
 *
 *   GET  /api/registry/mirrors            — list mirrors (public, with etags)
 *   GET  /api/registry/mirrors/:platform  — read one mirror (public)
 *   PUT  /api/registry/mirrors/:platform  — idempotent publish/upsert (moderator/admin)
 *
 * The stored body is served at /translated/<platform>/adagents.json by the
 * creative agent. Mounted at /api/registry alongside catalog-api.ts.
 */

import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import { CommunityMirrorDatabase } from '../db/community-mirror-db.js';
import { isRegistryModerator } from '../services/brand-logo-auth.js';
import { isWebUserAAOAdmin } from '../addie/admin-status-lookup.js';
import { validateAdagentsDocument } from '../services/adagents-schema-validator.js';
import { registryReadRateLimiter, brandCreationRateLimiter } from '../middleware/rate-limit.js';
import { createLogger } from '../logger.js';

const logger = createLogger('community-mirrors');

const PLATFORM_RE = /^[a-z0-9_-]{1,64}$/;

const MirrorBodySchema = z
  .object({
    catalog_etag: z.string().min(1).max(255).optional(),
    formats: z.array(z.unknown()).optional(),
    properties: z.array(z.unknown()).optional(),
    placements: z.array(z.unknown()).optional(),
    placement_tags: z.record(z.string(), z.unknown()).optional(),
    collections: z.array(z.unknown()).optional(),
    signals: z.array(z.unknown()).optional(),
    signal_tags: z.record(z.string(), z.unknown()).optional(),
    contact: z.unknown().optional(),
    superseded_by: z
      .string()
      .url()
      .refine(
        (v) => {
          try {
            // adagents.json requires superseded_by to be https (^https://).
            return new URL(v).protocol === 'https:';
          } catch {
            return false;
          }
        },
        { message: 'superseded_by must be an https URL' }
      )
      .optional(),
  })
  // adagents.json defaults additionalProperties:true; allow forward-compatible
  // catalog fields. `authorized_agents` is intentionally ignored and forced to
  // [] so a mirror can never imply sales authorization.
  .passthrough();

export interface CommunityMirrorRouterConfig {
  requireAuth?: RequestHandler;
}

/**
 * Resolve the authenticated caller and confirm they may manage community
 * mirrors — a registry moderator or AAO admin (the static ADMIN_API_KEY
 * sentinel always passes). Returns the user id, or null after sending the
 * 401/403 response. `req.user` has no isAdmin field — admin status is resolved
 * via isWebUserAAOAdmin, not the request.
 */
async function resolvePublisher(
  req: { user?: { id?: string; email?: string } },
  res: Response
): Promise<string | null> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (userId !== 'admin_api_key') {
    const [isAaoAdmin, isModerator] = await Promise.all([
      isWebUserAAOAdmin(userId),
      isRegistryModerator(userId),
    ]);
    if (!isAaoAdmin && !isModerator) {
      res.status(403).json({ error: 'Only registry moderators or AAO admins can manage community mirrors' });
      return null;
    }
  }
  return userId;
}

export function createCommunityMirrorRouter(config: CommunityMirrorRouterConfig): Router {
  const router = Router();
  const { requireAuth: authMiddleware } = config;
  const mirrorDb = new CommunityMirrorDatabase();

  const writeMiddleware: RequestHandler[] = authMiddleware
    ? [authMiddleware, brandCreationRateLimiter]
    : [brandCreationRateLimiter];

  // ── GET /api/registry/mirrors — list ────────────────────────────
  router.get('/mirrors', registryReadRateLimiter, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      const { mirrors, total } = await mirrorDb.list({
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      return res.json({ mirrors, total });
    } catch (err) {
      logger.error({ err }, 'Failed to list community mirrors');
      return res.status(500).json({ error: 'Failed to list community mirrors' });
    }
  });

  // ── GET /api/registry/mirrors/:platform — read one ──────────────
  router.get('/mirrors/:platform', registryReadRateLimiter, async (req, res) => {
    const platform = String(req.params.platform).toLowerCase();
    if (!PLATFORM_RE.test(platform)) {
      return res.status(400).json({ error: 'Invalid platform identifier' });
    }
    try {
      const mirror = await mirrorDb.getByPlatform(platform);
      if (!mirror) {
        return res.status(404).json({ error: 'Community mirror not found' });
      }
      return res.json({
        platform: mirror.platform,
        catalog_etag: mirror.catalog_etag,
        superseded_by: mirror.superseded_by,
        adagents_json: mirror.adagents_json,
        created_at: mirror.created_at,
        updated_at: mirror.updated_at,
      });
    } catch (err) {
      logger.error({ err, platform }, 'Failed to read community mirror');
      return res.status(500).json({ error: 'Failed to read community mirror' });
    }
  });

  // ── PUT /api/registry/mirrors/:platform — idempotent publish ────
  router.put('/mirrors/:platform', ...writeMiddleware, async (req, res) => {
    const platform = String(req.params.platform).toLowerCase();
    if (!PLATFORM_RE.test(platform)) {
      return res.status(400).json({ error: 'Invalid platform identifier (expected ^[a-z0-9_-]{1,64}$)' });
    }

    const userId = await resolvePublisher(req, res);
    if (!userId) return;

    const parsed = MirrorBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const body = parsed.data as Record<string, unknown> & {
      catalog_etag?: string;
      formats?: unknown[];
      properties?: unknown[];
      placements?: unknown[];
      placement_tags?: Record<string, unknown>;
      collections?: unknown[];
      signals?: unknown[];
      signal_tags?: Record<string, unknown>;
      superseded_by?: string;
    };

    const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
    const hasCatalogContent =
      nonEmpty(body.formats) ||
      nonEmpty(body.properties) ||
      nonEmpty(body.placements) ||
      nonEmpty(body.collections) ||
      nonEmpty(body.signals);
    if (!hasCatalogContent) {
      return res.status(400).json({
        error: 'A community mirror must carry catalog content (formats, properties, placements, collections, or signals)',
      });
    }

    // Assemble the served document: forced authorized_agents:[] + $schema.
    // authorized_agents is dropped so a mirror never asserts sales
    // authorization; $schema and last_updated are also stripped from the caller
    // body and regenerated below so both stay server-controlled.
    const { authorized_agents: _ignored, $schema: _schema, last_updated: _lu, ...rest } = body;
    const adagentsJson: Record<string, unknown> = {
      $schema: 'https://adcontextprotocol.org/schemas/v3/adagents.json',
      ...rest,
      authorized_agents: [],
      last_updated: new Date().toISOString(),
    };

    // Validate the fully-assembled document against the published adagents.json
    // schema before persisting — AAO must never serve a mirror that a buyer SDK
    // validating against the schema would reject (e.g. a formats[] entry
    // missing required params).
    const conformance = await validateAdagentsDocument(adagentsJson);
    if (!conformance.valid) {
      return res.status(400).json({
        error: 'Document does not conform to the adagents.json schema',
        details: conformance.errors.slice(0, 20),
      });
    }

    try {
      const mirror = await mirrorDb.upsert({
        platform,
        adagents_json: adagentsJson,
        catalog_etag: body.catalog_etag ?? null,
        superseded_by: body.superseded_by ?? null,
        created_by_user_id: userId,
        created_by_email: req.user?.email ?? null,
      });
      logger.info({ platform, by: userId }, 'Published community mirror');
      return res.json({
        success: true,
        platform: mirror.platform,
        catalog_etag: mirror.catalog_etag,
        superseded_by: mirror.superseded_by,
        updated_at: mirror.updated_at,
      });
    } catch (err) {
      logger.error({ err, platform }, 'Failed to publish community mirror');
      return res.status(500).json({ error: 'Failed to publish community mirror' });
    }
  });

  // ── DELETE /api/registry/mirrors/:platform — retire ─────────────
  router.delete('/mirrors/:platform', ...writeMiddleware, async (req, res) => {
    const platform = String(req.params.platform).toLowerCase();
    if (!PLATFORM_RE.test(platform)) {
      return res.status(400).json({ error: 'Invalid platform identifier (expected ^[a-z0-9_-]{1,64}$)' });
    }
    const userId = await resolvePublisher(req, res);
    if (!userId) return;

    try {
      const mirror = await mirrorDb.getByPlatform(platform);
      if (!mirror) {
        return res.status(404).json({ error: 'Community mirror not found' });
      }
      // Buyer caches key on the mirror URL and fall back to it until the
      // platform self-adopts. Refuse to remove a mirror that has not published
      // a `superseded_by` migration signal unless explicitly forced, so live
      // fallback traffic isn't yanked out from under buyers. (404 is the
      // documented "no mirror" state buyers already handle, so a hard delete
      // is safe once the deprecation window has been signalled.)
      const force = req.query.force === 'true';
      if (!mirror.superseded_by && !force) {
        return res.status(409).json({
          error:
            'Refusing to delete a mirror that has not been superseded. Set superseded_by first (so buyers get a migration signal), or pass ?force=true to delete anyway.',
        });
      }
      await mirrorDb.deleteByPlatform(platform);
      logger.info({ platform, by: userId, force }, 'Deleted community mirror');
      return res.json({ success: true, platform });
    } catch (err) {
      logger.error({ err, platform }, 'Failed to delete community mirror');
      return res.status(500).json({ error: 'Failed to delete community mirror' });
    }
  });

  return router;
}
