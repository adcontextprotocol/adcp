/**
 * Brand logo routes — upload, list, and admin review.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { logoUploadRateLimiter } from '../middleware/rate-limit.js';
import { BrandLogoDatabase } from '../db/brand-logo-db.js';
import { BrandDatabase } from '../db/brand-db.js';
import { BansDatabase } from '../db/bans-db.js';
import { isWebUserAAOAdmin } from '../addie/mcp/admin-tools.js';
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

const logger = createLogger('brand-logo-routes');

const logoDomainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

        // Membership check (skip for admin API key and WorkOS API keys with member flag)
        const isStaticAdmin = !!(req as any).isStaticAdminApiKey;
        if (!isStaticAdmin && !user.isMember) {
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

        // Insert
        const logo = await brandLogoDb.insertBrandLogo({
          domain,
          content_type: contentType,
          data: buffer,
          sha256,
          tags,
          width,
          height,
          source: 'community',
          review_status: 'pending',
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

        // Create a brand revision noting the upload
        try {
          await brandDb.editDiscoveredBrand(domain, {
            edit_summary: `Logo uploaded by ${user.email}`,
            editor_user_id: user.id,
            editor_email: user.email,
          });
        } catch {
          // Non-critical — the logo is saved regardless
        }

        return res.status(201).json({
          success: true,
          domain,
          logo_id: logo.id,
          review_status: 'pending',
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

        const user = (req as any).user;
        const isAdmin = user?.id ? await isWebUserAAOAdmin(user.id) : false;

        const logos = await brandLogoDb.listBrandLogos(domain, {
          tags: filterTags,
          include_all_statuses: isAdmin,
          ...(!isAdmin ? { review_status: 'approved' } : {}),
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
          if (isAdmin) {
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

  // POST /api/brands/:domain/logos/:id/review — Admin review
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
        if (!uuidPattern.test(logoId)) {
          return res.status(400).json({ error: 'Invalid logo ID' });
        }

        const isAdmin = await isWebUserAAOAdmin(user.id);
        if (!isAdmin) {
          return res.status(403).json({ error: 'Admin access required' });
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
            edit_summary: `Logo ${action}d by admin`,
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

  return router;
}
