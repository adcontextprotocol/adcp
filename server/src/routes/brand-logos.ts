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
import { resolvePrimaryOrganization } from '../db/users-db.js';
import {
  validateLogoTags,
  detectContentType,
  sanitizeSvg,
  extractDimensions,
  computeSha256,
  rebuildManifestLogos,
} from '../services/brand-logo-service.js';
import { getBrandAssetUrl } from '../services/logo-cdn.js';
import { createLogger } from '../logger.js';
import { isUuid } from '../utils/uuid.js';
import { notifyPendingBrandLogo, notifyBrandLogoReviewed } from '../notifications/registry.js';

const PENDING_REVIEW_SLA_HOURS = 48;
// Per-user pending-queue threshold: how many distinct brand domains a
// single uploader can have in pending state at once, in the rolling
// window. Trips when the user fans out uploads to enumerate ownership
// state or saturate the moderator queue. Tuned for the holding-company
// contributor pattern (one operator managing logos across many brands)
// — 5/hr was too tight; 15/24h gives legit batch sessions headroom
// while still blocking enumeration before it pays off.
const MAX_PENDING_DOMAINS_PER_USER = 15;
const PENDING_THRESHOLD_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
// Per-brand reserved owner slots: community uploads (pending or
// approved — rejected/deleted don't count) can fill at most this many
// of the brand's MAX_LOGOS_PER_BRAND slots. The remaining slots stay
// reserved for the eventual verified owner. 8/2 split lets community
// keep contributing on popular unowned brands while guaranteeing the
// owner room for at least logo+wordmark when they claim.
const MAX_COMMUNITY_LOGOS_PER_BRAND = 8;

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
        const hostedForOwnership = await brandDb.getHostedBrandByDomain(domain);
        const isOwner = await isVerifiedBrandOwner(user.id, domain, brandDb);
        if (!isOwner) {
          if (hostedForOwnership?.domain_verified && hostedForOwnership.workos_organization_id) {
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

        // Per-user abuse signal: refuse community uploads when the caller
        // already has MAX_PENDING_DOMAINS_PER_USER distinct domains pending
        // in the threshold window. Verified owners bypass — they're
        // attesting the brand they own, not enumerating. Soft-pause: just
        // rejects new attempts; existing pending entries stay, and the
        // threshold relaxes as moderators clear them. Returns 429 so
        // automated callers back off rather than retry.
        //
        // TOCTOU: the check + INSERT below is not atomic. Two concurrent
        // requests from the same user can both pass the threshold and
        // both insert (cap = N×concurrency). The HTTP route's rate
        // limiter bounds this. Hard upper limit is moderator workload,
        // not a security boundary.
        if (!isOwner) {
          const pendingDomainCount = await brandLogoDb.countPendingDomainsForUser(
            user.id,
            PENDING_THRESHOLD_WINDOW_MS,
          );
          if (pendingDomainCount >= MAX_PENDING_DOMAINS_PER_USER) {
            logger.warn(
              { userId: user.id, email: user.email, pendingDomainCount, domain },
              'brand-logo upload rejected: user pending-queue threshold tripped',
            );
            // Don't echo `pendingDomainCount` back to the caller — it's
            // a precise enumeration oracle for any attacker calibrating
            // their fan-out. `max_pending_domains` is the only signal
            // a legit client actually needs.
            return res.status(429).json({
              error: 'You have too many brand logo uploads awaiting review. Wait for moderators to clear the queue before adding more.',
              code: 'pending_queue_full',
              max_pending_domains: MAX_PENDING_DOMAINS_PER_USER,
            });
          }
        }

        // Logo count cap. Community uploads (pending OR approved —
        // rejected/deleted don't permanently consume slots) are reserved
        // to MAX_COMMUNITY_LOGOS_PER_BRAND so a verified owner uploading
        // after the community-pending pool filled isn't locked out of
        // their own brand. Owner uploads still respect the overall cap.
        if (isOwner) {
          const count = await brandLogoDb.countBrandLogos(domain);
          if (count >= MAX_LOGOS_PER_BRAND) {
            return res.status(400).json({ error: `Maximum ${MAX_LOGOS_PER_BRAND} logos per brand` });
          }
        } else {
          const communityCount = await brandLogoDb.countLogosBySource(domain, ['community']);
          if (communityCount >= MAX_COMMUNITY_LOGOS_PER_BRAND) {
            return res.status(400).json({
              error: `This brand already has ${communityCount} community-contributed logos pending or approved. Wait for moderators to clear some, or for the verified owner to claim and manage it.`,
              code: 'community_cap_reached',
            });
          }
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
        const uploaderOrgId = isOwner
          ? hostedForOwnership?.workos_organization_id ?? null
          : await resolvePrimaryOrganization(user.id).catch((err) => {
            logger.warn({ err, userId: user.id }, 'Failed to resolve uploader org for brand-logo provenance');
            return null;
          });

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
          uploaded_by_org_id: uploaderOrgId ?? undefined,
          uploaded_by_email: user.email,
          upload_note: note,
          original_filename: originalFilename,
          source_flow: isOwner ? 'brand_builder_owner_upload' : 'community_logo_upload',
          provenance: {
            approval_path: isOwner ? 'owner_auto_approved' : 'moderator_review_required',
            source_flow: isOwner ? 'brand_builder_owner_upload' : 'community_logo_upload',
            intended_use: 'brand_json',
            uploader_path: isOwner ? 'owner' : 'community',
          },
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
        if (!hostedForOwnership || !hostedForOwnership.domain_verified) {
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

        // Fire-and-forget Slack notification for pending uploads. Owners
        // who self-approve don't need a moderator nudge. Capture the
        // returned ts so the review path can thread its verdict reply
        // under the original announcement (#4748).
        if (reviewStatus === 'pending') {
          notifyPendingBrandLogo({
            domain,
            logo_id: logo.id,
            content_type: contentType,
            tags,
            uploader_email: user.email,
            uploader_name: user.firstName
              ? `${user.firstName} ${user.lastName ?? ''}`.trim()
              : undefined,
            upload_note: note,
            source: 'community',
          }).then((threadTs) => {
            if (threadTs) {
              return brandLogoDb.setSlackThreadTs(logo.id, threadTs);
            }
          }).catch((err) => {
            logger.warn({ err, domain }, 'Pending-logo Slack notification failed');
          });
        }

        return res.status(201).json({
          success: true,
          domain,
          logo_id: logo.id,
          review_status: reviewStatus,
          ...(reviewStatus === 'pending' && {
            message: `Logo queued for moderator review (typically within ${PENDING_REVIEW_SLA_HOURS}h). It will appear on the brand viewer once approved.`,
            review_sla_hours: PENDING_REVIEW_SLA_HOURS,
          }),
          url: getBrandAssetUrl(domain, logo.id, logo.content_type),
          legacy_url: `/logos/brands/${domain}/${logo.id}`,
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
            url: getBrandAssetUrl(domain, l.id, l.content_type),
            legacy_url: `/logos/brands/${domain}/${l.id}`,
          };
          if (l.width) base.width = l.width;
          if (l.height) base.height = l.height;
          if (canReview) {
            base.uploaded_by_email = l.uploaded_by_email;
            base.uploaded_by_org_id = l.uploaded_by_org_id;
            base.upload_note = l.upload_note;
            base.source_flow = l.source_flow;
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
        // `updateLogoReviewStatus` returns the post-mutation row via
        // RETURNING ${SUMMARY_COLUMNS}, which includes slack_thread_ts —
        // no separate pre-fetch needed. Saves a round-trip and removes a
        // TOCTOU window where the row could be deleted between fetch
        // and update.
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

        // Thread the verdict under the original pending-logo notification
        // when one exists. Fire-and-forget — Slack failure must not roll
        // back a moderator's decision.
        if (updated.slack_thread_ts) {
          notifyBrandLogoReviewed({
            thread_ts: updated.slack_thread_ts,
            domain,
            action: action as 'approve' | 'reject' | 'delete',
            reviewer_email: user.email,
            reviewer_name: user.firstName
              ? `${user.firstName} ${user.lastName ?? ''}`.trim()
              : undefined,
            note,
          }).catch((err) => {
            logger.warn({ err, domain, logoId }, 'Logo-review Slack thread reply failed');
          });
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
