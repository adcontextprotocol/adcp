/**
 * Community-mirror catalog lifecycle API (#2176).
 *
 * AgenticAdvertising.org publishes catalog-only adagents.json mirrors for
 * platforms that have not adopted AdCP (Meta, TikTok, …). These mirrors carry
 * catalog content (formats/properties/placements) and an empty `authorized_agents: []` — there
 * is no sales agent to authorize. This router makes them first-class:
 *
 *   GET  /api/registry/mirrors            — list mirrors (public, with etags)
 *   GET  /api/registry/mirrors/:platform  — read one mirror (public)
 *   PUT  /api/registry/mirrors/:platform  — publish for moderators, propose for other callers
 *   GET  /api/registry/mirror-proposals   — review queue or caller's own proposals
 *   POST /api/registry/mirror-proposals/:id/{approve,reject} — moderation
 *
 * The stored body is served at /translated/<platform>/adagents.json by the
 * creative agent. Mounted at /api/registry alongside catalog-api.ts.
 */

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CommunityMirrorDatabase } from '../db/community-mirror-db.js';
import type { CommunityMirror, CommunityMirrorProposal } from '../db/community-mirror-db.js';
import { PublisherDatabase } from '../db/publisher-db.js';
import type { CatalogEventsDatabase } from '../db/catalog-events-db.js';
import { getClient } from '../db/client.js';
import { isRegistryModerator } from '../services/brand-logo-auth.js';
import { isWebUserAAOAdmin } from '../addie/admin-status-lookup.js';
import { validateAdagentsDocument } from '../services/adagents-schema-validator.js';
import { registryReadRateLimiter, brandCreationRateLimiter } from '../middleware/rate-limit.js';
import { createLogger } from '../logger.js';
import { resolveCallerOrgId } from './helpers/resolve-caller-org.js';

const logger = createLogger('community-mirrors');

const PLATFORM_RE = /^[a-z0-9_-]{1,64}$/;
const ProposalIdSchema = z.string().uuid();
const ProposalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_PROPOSAL_BYTES = 1024 * 1024;
const MAX_PROPOSAL_CATALOG_ITEMS = 2000;

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
  eventsDb?: CatalogEventsDatabase;
}

/**
 * Organization API keys represent an organization, not a human working-group
 * member, so they intentionally submit proposals instead of passing this gate.
 */
async function canManageMirrors(userId: string): Promise<boolean> {
  if (userId === 'admin_api_key') return true;
  if (userId.startsWith('api_key_')) return false;
  const [isOrganizationAdmin, isModerator] = await Promise.all([
    isWebUserAAOAdmin(userId),
    isRegistryModerator(userId),
  ]);
  return isOrganizationAdmin || isModerator;
}

async function resolveManager(
  req: { user?: { id?: string } },
  res: Response
): Promise<string | null> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!(await canManageMirrors(userId))) {
    res.status(403).json({
      error: 'Only registry moderators or AgenticAdvertising.org administrators can manage community mirrors',
    });
    return null;
  }
  return userId;
}

async function callerOrganizationId(req: Request): Promise<string | null> {
  const attached = (req as Request & { apiKey?: { organizationId?: string } }).apiKey?.organizationId;
  return attached ?? resolveCallerOrgId(req);
}

function reviewedContentDigest(document: Record<string, unknown>): string {
  const { last_updated: _lastUpdated, ...reviewedContent } = document;
  return createHash('sha256').update(JSON.stringify(reviewedContent)).digest('hex');
}

function proposalDigest(document: Record<string, unknown>, baseMirrorDigest: string | null): string {
  return createHash('sha256')
    .update(`${baseMirrorDigest ?? 'no-public-mirror'}:${reviewedContentDigest(document)}`)
    .digest('hex');
}

function proposalForResponse(proposal: CommunityMirrorProposal) {
  const {
    proposed_by_user_id: _proposedByUserId,
    proposed_by_email: _proposedByEmail,
    reviewed_by_user_id: _reviewedByUserId,
    ...safe
  } = proposal;
  return safe;
}

export function createCommunityMirrorRouter(config: CommunityMirrorRouterConfig): Router {
  const router = Router();
  const { requireAuth: authMiddleware, eventsDb } = config;
  const mirrorDb = new CommunityMirrorDatabase();
  const publisherDb = new PublisherDatabase();

  const writeMiddleware: RequestHandler[] = authMiddleware
    ? [authMiddleware, brandCreationRateLimiter]
    : [brandCreationRateLimiter];
  const authenticatedReadMiddleware: RequestHandler[] = authMiddleware
    ? [authMiddleware, registryReadRateLimiter]
    : [registryReadRateLimiter];

  async function lockPlatform(client: PoolClient, platform: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`community-mirror:${platform}`]);
  }

  async function publishWithClient(
    client: PoolClient,
    previousMirror: CommunityMirror | null,
    input: {
      platform: string;
      adagentsJson: Record<string, unknown>;
      catalogEtag: string | null;
      supersededBy: string | null;
      userId: string;
      email: string | null;
    },
  ) {
    const mirror = await mirrorDb.upsertWithClient(client, {
      platform: input.platform,
      adagents_json: input.adagentsJson,
      catalog_etag: input.catalogEtag,
      superseded_by: input.supersededBy,
      created_by_user_id: input.userId,
      created_by_email: input.email,
    });
    const publisherDomains = await publisherDb.replaceCommunityAdagentsCatalogWithClient(client, {
      platform: input.platform,
      manifest: input.adagentsJson,
      previousManifest: previousMirror?.adagents_json ?? null,
      catalogUrl: `/api/creative-agent/translated/${input.platform}/adagents.json`,
      createdByUserId: input.userId,
      createdByEmail: input.email,
      eventsDb,
    });
    return { mirror, publisherDomains };
  }

  // ── Community proposal and moderation workflow ─────────────────
  router.get('/mirror-proposals', ...authenticatedReadMiddleware, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const requestedStatus = req.query.status ? String(req.query.status) : undefined;
    if (requestedStatus && !['pending', 'approved', 'rejected'].includes(requestedStatus)) {
      return res.status(400).json({ error: 'Invalid proposal status' });
    }
    const isManager = await canManageMirrors(userId);
    const organizationId = isManager ? null : await callerOrganizationId(req);
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;
    try {
      const result = await mirrorDb.listProposals({
        status: (requestedStatus ?? (isManager ? 'pending' : undefined)) as
          | 'pending'
          | 'approved'
          | 'rejected'
          | undefined,
        proposedByOrganizationId: isManager ? undefined : organizationId ?? undefined,
        proposedByUserId: isManager || organizationId ? undefined : userId,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      return res.json(result);
    } catch (err) {
      logger.error({ err, userId }, 'Failed to list community mirror proposals');
      return res.status(500).json({ error: 'Failed to list community mirror proposals' });
    }
  });

  router.get('/mirror-proposals/:id', ...authenticatedReadMiddleware, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const proposalId = String(req.params.id);
    if (!ProposalIdSchema.safeParse(proposalId).success) {
      return res.status(400).json({ error: 'Invalid proposal identifier' });
    }
    try {
      const proposal = await mirrorDb.getProposalById(proposalId);
      if (!proposal) return res.status(404).json({ error: 'Community mirror proposal not found' });
      const isManager = await canManageMirrors(userId);
      const organizationId = isManager ? null : await callerOrganizationId(req);
      const ownsProposal = organizationId
        ? proposal.proposed_by_organization_id === organizationId
        : proposal.proposed_by_user_id === userId;
      if (!ownsProposal && !isManager) {
        return res.status(404).json({ error: 'Community mirror proposal not found' });
      }
      return res.json({ proposal: proposalForResponse(proposal) });
    } catch (err) {
      logger.error({ err, proposalId }, 'Failed to read community mirror proposal');
      return res.status(500).json({ error: 'Failed to read community mirror proposal' });
    }
  });

  router.post('/mirror-proposals/:id/approve', ...writeMiddleware, async (req, res) => {
    const managerId = await resolveManager(req, res);
    if (!managerId) return;
    const proposalId = String(req.params.id);
    if (!ProposalIdSchema.safeParse(proposalId).success) {
      return res.status(400).json({ error: 'Invalid proposal identifier' });
    }
    const review = z.object({
      proposal_digest: ProposalDigestSchema,
      review_notes: z.string().trim().max(2000).optional(),
    }).safeParse(req.body ?? {});
    if (!review.success) return res.status(400).json({ error: 'Invalid review body', details: review.error.issues });

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const proposal = await mirrorDb.getProposalByIdWithClient(client, proposalId);
      if (!proposal) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Community mirror proposal not found' });
      }
      if (proposal.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Community mirror proposal is already ${proposal.status}` });
      }
      if (proposal.proposal_digest !== review.data.proposal_digest) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Proposal changed after review. Fetch the latest proposal and approve its new proposal_digest.',
        });
      }

      await lockPlatform(client, proposal.platform);
      const currentMirror = await mirrorDb.getByPlatformWithClient(client, proposal.platform);
      const currentBaseDigest = currentMirror ? reviewedContentDigest(currentMirror.adagents_json) : null;
      if (proposal.base_mirror_digest !== currentBaseDigest) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'The published mirror changed after this proposal was submitted. Resubmit against the current mirror.',
        });
      }

      const { last_updated: _lastUpdated, authorized_agents: _authorizedAgents, ...proposalBody } =
        proposal.adagents_json;
      const adagentsJson = {
        ...proposalBody,
        authorized_agents: [],
        last_updated: new Date().toISOString(),
      };
      const conformance = await validateAdagentsDocument(adagentsJson);
      if (!conformance.valid) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Proposed document no longer conforms to the adagents.json schema',
          details: conformance.errors.slice(0, 20),
        });
      }

      const { mirror, publisherDomains } = await publishWithClient(client, currentMirror, {
        platform: proposal.platform,
        adagentsJson,
        catalogEtag: proposal.catalog_etag,
        supersededBy: proposal.superseded_by,
        userId: managerId,
        email: req.user?.email ?? null,
      });
      await mirrorDb.approveProposalWithClient(client, proposalId, managerId, review.data.review_notes);
      await client.query('COMMIT');
      logger.info({ proposalId, platform: proposal.platform, by: managerId }, 'Approved community mirror proposal');
      return res.json({
        success: true,
        proposal_id: proposalId,
        platform: mirror.platform,
        catalog_etag: mirror.catalog_etag,
        superseded_by: mirror.superseded_by,
        publisher_domains: publisherDomains,
        updated_at: mirror.updated_at,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ err, proposalId }, 'Failed to approve community mirror proposal');
      return res.status(500).json({ error: 'Failed to approve community mirror proposal' });
    } finally {
      client.release();
    }
  });

  router.post('/mirror-proposals/:id/reject', ...writeMiddleware, async (req, res) => {
    const managerId = await resolveManager(req, res);
    if (!managerId) return;
    const proposalId = String(req.params.id);
    if (!ProposalIdSchema.safeParse(proposalId).success) {
      return res.status(400).json({ error: 'Invalid proposal identifier' });
    }
    const review = z.object({
      proposal_digest: ProposalDigestSchema,
      review_notes: z.string().trim().min(1).max(2000),
    }).safeParse(req.body);
    if (!review.success) return res.status(400).json({ error: 'Invalid review body', details: review.error.issues });
    try {
      const proposal = await mirrorDb.rejectProposal(
        proposalId,
        review.data.proposal_digest,
        managerId,
        review.data.review_notes,
      );
      if (!proposal) {
        const existing = await mirrorDb.getProposalById(proposalId);
        if (!existing) return res.status(404).json({ error: 'Community mirror proposal not found' });
        if (existing.status === 'pending') {
          return res.status(409).json({
            error: 'Proposal changed after review. Fetch the latest proposal and reject its new proposal_digest.',
          });
        }
        return res.status(409).json({ error: `Community mirror proposal is already ${existing.status}` });
      }
      logger.info({ proposalId, platform: proposal.platform, by: managerId }, 'Rejected community mirror proposal');
      return res.json({ success: true, proposal: proposalForResponse(proposal) });
    } catch (err) {
      logger.error({ err, proposalId }, 'Failed to reject community mirror proposal');
      return res.status(500).json({ error: 'Failed to reject community mirror proposal' });
    }
  });

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

  // ── PUT /api/registry/mirrors/:platform — publish or propose ────
  router.put('/mirrors/:platform', ...writeMiddleware, async (req, res) => {
    const platform = String(req.params.platform).toLowerCase();
    if (!PLATFORM_RE.test(platform)) {
      return res.status(400).json({ error: 'Invalid platform identifier (expected ^[a-z0-9_-]{1,64}$)' });
    }

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const isManager = await canManageMirrors(userId);
    const organizationId = isManager ? null : await callerOrganizationId(req);
    if (!isManager && !organizationId) {
      return res.status(403).json({ error: 'Organization context is required to propose a community mirror' });
    }
    if (!isManager) {
      const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      if (Buffer.byteLength(rawBody, 'utf8') > MAX_PROPOSAL_BYTES) {
        return res.status(413).json({ error: 'Community mirror proposals must not exceed 1 MiB' });
      }
    }

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
    if (!isManager) {
      const catalogItemCount = [body.formats, body.properties, body.placements, body.collections, body.signals]
        .reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0);
      if (catalogItemCount > MAX_PROPOSAL_CATALOG_ITEMS) {
        return res.status(413).json({
          error: `Community mirror proposals may contain at most ${MAX_PROPOSAL_CATALOG_ITEMS} catalog items`,
        });
      }
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
    // schema before persisting — the registry must never serve a mirror that a buyer SDK
    // validating against the schema would reject (e.g. a formats[] entry
    // missing required params).
    const conformance = await validateAdagentsDocument(adagentsJson);
    if (!conformance.valid) {
      return res.status(400).json({
        error: 'Document does not conform to the adagents.json schema',
        details: conformance.errors.slice(0, 20),
      });
    }

    if (!isManager) {
      try {
        const currentMirror = await mirrorDb.getByPlatform(platform);
        const baseMirrorDigest = currentMirror ? reviewedContentDigest(currentMirror.adagents_json) : null;
        const digest = proposalDigest(adagentsJson, baseMirrorDigest);
        const proposal = await mirrorDb.submitProposal({
          platform,
          adagents_json: adagentsJson,
          catalog_etag: body.catalog_etag ?? null,
          superseded_by: body.superseded_by ?? null,
          proposal_digest: digest,
          base_mirror_digest: baseMirrorDigest,
          proposed_by_user_id: userId,
          proposed_by_email: req.user?.email ?? null,
          proposed_by_organization_id: organizationId,
        });
        logger.info({ platform, proposalId: proposal.id, by: userId }, 'Submitted community mirror proposal');
        const statusUrl = `/api/registry/mirror-proposals/${proposal.id}`;
        res.setHeader('Location', statusUrl);
        return res.status(202).json({
          success: true,
          status: 'pending',
          proposal_id: proposal.id,
          proposal_digest: proposal.proposal_digest,
          platform: proposal.platform,
          status_url: statusUrl,
          submitted_at: proposal.proposed_at,
        });
      } catch (err) {
        logger.error({ err, platform }, 'Failed to submit community mirror proposal');
        return res.status(500).json({ error: 'Failed to submit community mirror proposal' });
      }
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await lockPlatform(client, platform);
      const previousMirror = await mirrorDb.getByPlatformWithClient(client, platform);
      const { mirror, publisherDomains } = await publishWithClient(client, previousMirror, {
        platform,
        adagentsJson,
        catalogEtag: body.catalog_etag ?? null,
        supersededBy: body.superseded_by ?? null,
        userId,
        email: req.user?.email ?? null,
      });
      await client.query('COMMIT');
      logger.info({ platform, by: userId }, 'Published community mirror');
      return res.json({
        success: true,
        platform: mirror.platform,
        catalog_etag: mirror.catalog_etag,
        superseded_by: mirror.superseded_by,
        publisher_domains: publisherDomains,
        updated_at: mirror.updated_at,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ err, platform }, 'Failed to publish community mirror');
      return res.status(500).json({ error: 'Failed to publish community mirror' });
    } finally {
      client.release();
    }
  });

  // ── DELETE /api/registry/mirrors/:platform — retire ─────────────
  router.delete('/mirrors/:platform', ...writeMiddleware, async (req, res) => {
    const platform = String(req.params.platform).toLowerCase();
    if (!PLATFORM_RE.test(platform)) {
      return res.status(400).json({ error: 'Invalid platform identifier (expected ^[a-z0-9_-]{1,64}$)' });
    }
    const userId = await resolveManager(req, res);
    if (!userId) return;

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await lockPlatform(client, platform);
      const mirror = await mirrorDb.getByPlatformWithClient(client, platform);
      if (!mirror) {
        await client.query('ROLLBACK');
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
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            'Refusing to delete a mirror that has not been superseded. Set superseded_by first (so buyers get a migration signal), or pass ?force=true to delete anyway.',
        });
      }
      await publisherDb.retireCommunityAdagentsCatalogWithClient(client, platform, mirror.adagents_json);
      await mirrorDb.deleteByPlatformWithClient(client, platform);
      await client.query('COMMIT');
      logger.info({ platform, by: userId, force }, 'Deleted community mirror');
      return res.json({ success: true, platform });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ err, platform }, 'Failed to delete community mirror');
      return res.status(500).json({ error: 'Failed to delete community mirror' });
    } finally {
      client.release();
    }
  });

  return router;
}
