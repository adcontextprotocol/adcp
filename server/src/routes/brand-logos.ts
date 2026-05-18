/**
 * Brand logo routes — upload, list, and review.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { logoUploadRateLimiter } from '../middleware/rate-limit.js';
import { BrandLogoDatabase } from '../db/brand-logo-db.js';
import { BrandDatabase } from '../db/brand-db.js';
import { BansDatabase } from '../db/bans-db.js';
import { canReviewBrandLogos, isRegistryModerator, isVerifiedBrandOwner } from '../services/brand-logo-auth.js';
import { enrichUserWithMembership } from '../utils/html-config.js';
import {
  validateLogoTags,
  detectContentType,
  sanitizeSvg,
  extractDimensions,
  computeSha256,
  rebuildManifestLogos,
} from '../services/brand-logo-service.js';
import { createLogger } from '../logger.js';
import { isUuid } from '../utils/uuid.js';

const logger = createLogger('brand-logo-routes');

const logoDomainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const MAX_LOGOS_PER_BRAND = 10;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Accept all MIME types in multer — validate via magic bytes after upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

export interface BrandLogoRoutesConfig {
  brandDb: BrandDatabase;
  bansDb: BansDatabase;
}

export function createBrandLogoRouter(config: BrandLogoRoutesConfig): Router {
  const { brandDb, bansDb } = config;
  const brandLogoDb = new BrandLogoDatabase();
  const router = Router();

  // POST /api/brands/:domain/logos — Upload a logo
  router.post(
    '/brands/:domain/logos',
    requireAuth,
    logoUploadRateLimiter,
    upload.single('file'),
    async (req: Request, res: Response) => {
      try {
        const domain = req.params.domain.toLowerCase();
        const user = (req as any).user;

        if (!logoDomainPattern.test(domain)) {
          return res.status(400).json({ error: 'Invalid domain' });
        }

        // Membership check
        if (!user.isMember) {
          const enriched = await enrichUserWithMembership(user);
          if (!enriched?.isMember) {
            return res.status(403).json({ error: 'Membership required to upload logos' });
          }
        }

        // Ban check
        const banResult = await bansDb.isUserBannedFromRegistry('registry_brand', user.id, domain);
        if (banResult.banned) {
          return res.status(403).json({ error: 'You are banned from this brand registry' });
        }

        // Write authority: when a brand has a verified owner, only members of
        // that org can mutate its logos. Community contributors lose write
        // access the moment ownership is proven — anything else would let a
        // bad actor swap the storefront logo on a brand someone has actually
        // claimed. When no owner has verified yet, community uploads stay
        // allowed but queue for moderation (see review_status below).
        const isOwner = await isVerifiedBrandOwner(user.id, domain, brandDb);
        if (!isOwner) {
          const hosted = await brandDb.getHostedBrandByDomain(domain);
          if (hosted?.domain_verified && hosted.workos_organization_id) {
            return res.status(403).json({
              error: `This brand is verified-owned. Only members of the owning organization can change its logo. If you believe you own ${domain}, start a brand-claim challenge to prove DNS control.`,
              code: 'verified_owner_required',
              claim_url: `/brand/builder?domain=${encodeURIComponent(domain)}`,
            });
          }
        }

        if (!req.file) {
          return res.status(400).json({ error: 'File is required' });
        }

        // Logo count cap
        const count = await brandLogoDb.countBrandLogos(domain);
        if (count >= MAX_LOGOS_PER_BRAND) {
          return res.status(400).json({ error: `Maximum ${MAX_LOGOS_PER_BRAND} logos per brand` });
        }

        // Validate tags
        const rawTags = typeof req.body.tags === 'string' ? req.body.tags : '';
        const tags = rawTags.split(',').map((t: string) => t.trim()).filter(Boolean);
        if (tags.length === 0) {
          return res.status(400).json({ error: 'At least one tag is required' });
        }
        const tagValidation = validateLogoTags(tags);
        if (!tagValidation.valid) {
          return res.status(400).json({ error: `Invalid tags: ${tagValidation.invalid.join(', ')}` });
        }

        let buffer = req.file.buffer;

        // Detect content type from magic bytes
        const contentType = await detectContentType(buffer);
        if (!contentType) {
          return res.status(400).json({ error: 'Unsupported file type. Accepted: PNG, JPEG, SVG, WebP, GIF' });
        }

        // SVG sanitization
        if (contentType === 'image/svg+xml') {
          buffer = sanitizeSvg(buffer);
        }

        // SHA-256 dedup
        const sha256 = computeSha256(buffer);

        // Extract dimensions for raster images
        const { width, height } = await extractDimensions(buffer, contentType);

        // Upload note
        const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : undefined;

        // Original filename
        const originalFilename = req.file.originalname?.slice(0, 255);

        // Verified owners are auto-approved — domain control is the attestation.
        // Community uploads (only allowed when no owner has verified yet) queue
        // for moderator review so a bad actor can't instantly swap a brand's
        // storefront logo. Walks back the community half of #3393 per Brian's
        // direction; ops tunes the moderation cadence.
        const source = isOwner ? 'brand_owner' : 'community';
        const reviewStatus = isOwner ? 'approved' : 'pending';

        // Insert
        const logo = await brandLogoDb.insertBrandLogo({
          domain,
          content_type: contentType,
          data: buffer,
          sha256,
          tags,
          width,
          height,
          source,
          review_status: reviewStatus,
          uploaded_by_user_id: user.id,
          uploaded_by_email: user.email,
          upload_note: note,
          original_filename: originalFilename,
        });

        if (!logo) {
          return res.status(409).json({ error: 'Duplicate logo already exists for this brand' });
        }

        // If brand doesn't exist, create it
        const existing = await brandDb.getDiscoveredBrandByDomain(domain);
        if (!existing) {
          try {
            await brandDb.createDiscoveredBrand(
              {
                domain,
                source_type: 'community',
              },
              {
                user_id: user.id,
                email: user.email,
                name: user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : undefined,
              }
            );
          } catch (err) {
            // Brand may have been created concurrently — not an error
            logger.debug({ err, domain }, 'Brand creation skipped (may already exist)');
          }
        }

        // Rebuild manifest so the new logo shows immediately. Verified hosted brands
        // manage their manifest via brand.json — skip the rebuild for those.
        const hosted = await brandDb.getHostedBrandByDomain(domain);
        if (!hosted || !hosted.domain_verified) {
          await rebuildManifestLogos(domain, brandLogoDb, brandDb);
        }

        // Create a brand revision noting the upload
        try {
          const reviewNote = isOwner ? 'verified owner — auto-approved' : 'community — pending review';
          await brandDb.editDiscoveredBrand(domain, {
            edit_summary: `Logo uploaded by ${user.email} (${reviewNote})`,
            editor_user_id: user.id,
            editor_email: user.email,
          });
        } catch (err) {
          // Audit-revision write failed — the logo is saved regardless, but
          // log so we can spot drift between brand_revisions and the logo
          // table (e.g. a brand that's pending review can't take revisions).
          logger.debug({ err, domain, userId: user.id }, 'Logo upload audit revision skipped');
        }

        return res.status(201).json({
          success: true,
          domain,
          logo_id: logo.id,
          review_status: reviewStatus,
          ...(reviewStatus === 'pending' && {
            message: 'Logo queued for moderator review. It will appear on the brand viewer once approved.',
          }),
          url: `/logos/brands/${domain}/${logo.id}`,
        });
      } catch (error) {
        logger.error({ err: error, domain: req.params.domain }, 'Logo upload failed');
        return res.status(500).json({ error: 'Logo upload failed' });
      }
    },
  );

  // GET /api/brands/:domain/logos — List logos for a brand
  router.get(
    '/brands/:domain/logos',
    optionalAuth,
    async (req: Request, res: Response) => {
      try {
        const domain = req.params.domain.toLowerCase();
        if (!logoDomainPattern.test(domain)) {
          return res.status(400).json({ error: 'Invalid domain' });
        }

        // Validate tags filter
        const rawTags = typeof req.query.tags === 'string' ? req.query.tags : '';
        const filterTags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : undefined;
        if (filterTags && filterTags.length > 0) {
          const tagValidation = validateLogoTags(filterTags);
          if (!tagValidation.valid) {
            return res.status(400).json({ error: `Unknown tags: ${tagValidation.invalid.join(', ')}` });
          }
        }

        // Reviewers see all statuses (pending, rejected) for brands they manage
        const user = (req as any).user;
        const canReview = user?.id ? await canReviewBrandLogos(user.id, domain, brandDb) : false;

        const logos = await brandLogoDb.listBrandLogos(domain, {
          tags: filterTags,
          include_all_statuses: canReview,
          ...(!canReview ? { review_status: 'approved' } : {}),
        });

        const mapped = logos.map(l => {
          const base: Record<string, unknown> = {
            id: l.id,
            content_type: l.content_type,
            source: l.source,
            review_status: l.review_status,
            tags: l.tags,
            url: `/logos/brands/${domain}/${l.id}`,
          };
          if (l.width) base.width = l.width;
          if (l.height) base.height = l.height;
          if (canReview) {
            base.uploaded_by_email = l.uploaded_by_email;
            base.upload_note = l.upload_note;
            base.created_at = l.created_at;
          }
          return base;
        });

        return res.json({ domain, logos: mapped });
      } catch (error) {
        logger.error({ err: error, domain: req.params.domain }, 'Failed to list logos');
        return res.status(500).json({ error: 'Failed to list logos' });
      }
    },
  );

  // POST /api/brands/:domain/logos/:id/review — Review a logo
  router.post(
    '/brands/:domain/logos/:id/review',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const domain = req.params.domain.toLowerCase();
        const logoId = req.params.id;
        const user = (req as any).user;

        if (!logoDomainPattern.test(domain)) {
          return res.status(400).json({ error: 'Invalid domain' });
        }
        if (!isUuid(logoId)) {
          return res.status(400).json({ error: 'Invalid logo ID' });
        }

        // Authorization: registry moderator or verified brand owner
        const authorized = await canReviewBrandLogos(user.id, domain, brandDb);
        if (!authorized) {
          return res.status(403).json({ error: 'Only registry moderators or verified brand owners can review logos' });
        }

        const action = req.body.action as string;
        const statusMap: Record<string, 'approved' | 'rejected' | 'deleted'> = {
          approve: 'approved',
          reject: 'rejected',
          delete: 'deleted',
        };
        const status = statusMap[action];
        if (!status) {
          return res.status(400).json({ error: 'Invalid action. Must be approve, reject, or delete.' });
        }

        const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : undefined;
        const updated = await brandLogoDb.updateLogoReviewStatus(
          logoId,
          domain,
          status,
          user.id,
          note,
        );

        if (!updated) {
          return res.status(404).json({ error: 'Logo not found' });
        }

        // On approve: rebuild manifest (skip for verified hosted brands)
        if (action === 'approve') {
          const hosted = await brandDb.getHostedBrandByDomain(domain);
          if (!hosted || !hosted.domain_verified) {
            await rebuildManifestLogos(domain, brandLogoDb, brandDb);
          }
        }

        // Create brand revision
        try {
          await brandDb.editDiscoveredBrand(domain, {
            edit_summary: `Logo ${action}d by ${user.email}`,
            editor_user_id: user.id,
            editor_email: user.email,
          });
        } catch {
          // Non-critical
        }

        return res.json({
          success: true,
          logo_id: logoId,
          review_status: status,
        });
      } catch (error) {
        logger.error({ err: error, domain: req.params.domain, id: req.params.id }, 'Logo review failed');
        return res.status(500).json({ error: 'Logo review failed' });
      }
    },
  );

  // GET /api/brand-logos/pending — cross-brand moderator queue.
  // Returns the global list of pending logo uploads so moderators can
  // drain them from one page rather than walking each brand individually.
  router.get(
    '/brand-logos/pending',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = (req as any).user;
        const moderator = await isRegistryModerator(user.id);
        if (!moderator) {
          return res.status(403).json({ error: 'Brand-registry moderators only' });
        }

        const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
        const rawOffset = parseInt(String(req.query.offset ?? ''), 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
        const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

        const rows = await brandLogoDb.getPendingLogos(limit, offset);
        const logos = rows.map((l) => ({
          id: l.id,
          domain: l.domain,
          brand_name: (l as { brand_name?: string }).brand_name ?? null,
          content_type: l.content_type,
          source: l.source,
          tags: l.tags,
          width: l.width,
          height: l.height,
          uploaded_by_email: l.uploaded_by_email,
          uploaded_by_user_id: l.uploaded_by_user_id,
          upload_note: l.upload_note,
          original_filename: l.original_filename,
          created_at: l.created_at,
          preview_url: `/api/brand-logos/${l.id}/preview`,
          review_url: `/api/brands/${encodeURIComponent(l.domain)}/logos/${l.id}/review`,
          brand_view_url: `/brand/view/${encodeURIComponent(l.domain)}`,
        }));
        return res.json({ logos, limit, offset });
      } catch (error) {
        logger.error({ err: error }, 'Failed to list pending logos');
        return res.status(500).json({ error: 'Failed to list pending logos' });
      }
    },
  );

  // GET /api/brand-logos/:id/preview — moderator-only (or owner-of-the-
  // brand-this-logo-belongs-to) image bytes for any review_status. The
  // public CDN path (/logos/brands/:domain/:id) is strictly approved-only
  // by design (#3393 follow-ups); this is the moderator escape hatch so
  // they can actually see what they're reviewing.
  //
  // IMPORTANT: the owner-fallback path MUST gate on the row's stored
  // domain (`row.domain`), never on a caller-supplied domain. Otherwise
  // any verified owner of any brand could read any other brand's pending
  // logo bytes by guessing UUIDs.
  router.get(
    '/brand-logos/:id/preview',
    requireAuth,
    logoUploadRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const user = (req as any).user;
        const logoId = req.params.id;
        if (!isUuid(logoId)) {
          return res.status(400).json({ error: 'Invalid logo ID' });
        }

        const row = await brandLogoDb.getBrandLogoById(logoId);
        const moderator = await isRegistryModerator(user.id);
        const owner = row ? await isVerifiedBrandOwner(user.id, row.domain, brandDb) : false;

        // Conflate not-found and not-authorized for unauthorized callers
        // so a UUID guesser can't distinguish "this id doesn't exist" from
        // "exists but you can't read it" — that distinction is an
        // existence oracle. Moderators are the only callers who need the
        // genuine 404 (e.g. when the queue UI is showing a stale row).
        if (!row || (!moderator && !owner)) {
          if (moderator) {
            return res.status(404).json({ error: 'Logo not found' });
          }
          return res.status(403).json({ error: 'Not authorized to preview this logo' });
        }

        res.setHeader('Content-Type', row.content_type);
        // Pending bytes can be approved, rejected, or hard-deleted
        // mid-cache. `private` keeps shared caches out; `no-store` keeps
        // the browser from replaying stale image bytes after a verdict.
        res.setHeader('Cache-Control', 'private, no-store');
        return res.send(row.data);
      } catch (error) {
        logger.error({ err: error, id: req.params.id }, 'Failed to serve logo preview');
        return res.status(500).json({ error: 'Failed to serve preview' });
      }
    },
  );

  return router;
}
