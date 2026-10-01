/**
 * POST /api/brands/import — propose brand.json fields from a brand guide.
 *
 * Accepts a multipart upload (`file`: PDF or PPTX, plus `domain`) or JSON
 * `{ url, domain }`. Open to anonymous visitors (brandjson.org has no
 * session), so it is bounded by per-IP rate limits, a per-IP daily dollar
 * budget, and a global daily budget. Nothing is stored.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import * as crypto from 'crypto';
import { createLogger } from '../logger.js';
import { checkCostCap, recordCost } from '../addie/claude-cost-tracker.js';
import { brandImportDailyRateLimiter, brandImportHourlyRateLimiter } from '../middleware/rate-limit.js';
import {
  BrandBookImportError,
  importBrandBook,
  MAX_BRAND_BOOK_BYTES,
  sourceFromUpload,
  sourceFromUrl,
  type BrandBookSource,
} from '../services/brand-book-import.js';

const logger = createLogger('brand-import-route');

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Shared ceiling across all anonymous imports; the per-IP budget is the anonymous tier's. */
export const BRAND_IMPORT_GLOBAL_SCOPE = 'brand-import:global';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BRAND_BOOK_BYTES },
});

function ipScope(req: Request): string {
  const ip = req.ip ?? 'unknown';
  return `brand-import:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16)}`;
}

function parseUpload(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('multipart/form-data')) return next();
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File is larger than 20 MB.' });
      return;
    }
    if (err) {
      res.status(400).json({ error: 'Could not read the upload.' });
      return;
    }
    next();
  });
}

export interface BrandImportRouterDeps {
  importBrandBook?: typeof importBrandBook;
  sourceFromUrl?: typeof sourceFromUrl;
  checkCostCap?: typeof checkCostCap;
  recordCost?: typeof recordCost;
}

export function createBrandImportRouter(deps: BrandImportRouterDeps = {}): Router {
  const runImport = deps.importBrandBook ?? importBrandBook;
  const fetchSource = deps.sourceFromUrl ?? sourceFromUrl;
  const costCap = deps.checkCostCap ?? checkCostCap;
  const record = deps.recordCost ?? recordCost;
  const router = Router();

  router.post(
    '/brands/import',
    brandImportHourlyRateLimiter,
    brandImportDailyRateLimiter,
    parseUpload,
    async (req: Request, res: Response) => {
      const domain = String(req.body?.domain ?? '').trim().toLowerCase();
      if (!DOMAIN_PATTERN.test(domain)) {
        return res.status(400).json({ error: 'Enter the brand domain first, for example acme.example.' });
      }

      const scope = ipScope(req);
      const [perIp, global] = await Promise.all([
        costCap(scope, 'anonymous'),
        costCap(BRAND_IMPORT_GLOBAL_SCOPE, 'public_community'),
      ]);
      if (!perIp.ok || !global.ok) {
        return res.status(429).json({
          error: 'Brand-book import has reached its daily limit. Please try again tomorrow, or build your brand.json by hand.',
        });
      }

      try {
        let source: BrandBookSource;
        if (req.file) {
          source = sourceFromUpload(req.file.buffer);
        } else if (typeof req.body?.url === 'string' && req.body.url.trim()) {
          source = await fetchSource(req.body.url.trim());
        } else {
          return res.status(400).json({ error: 'Upload a PDF or PowerPoint file, or paste a link to your brand guidelines.' });
        }

        const result = await runImport(source, domain);
        await Promise.all([
          record(scope, result.model, result.usage),
          record(BRAND_IMPORT_GLOBAL_SCOPE, result.model, result.usage),
        ]).catch((error) => logger.warn({ err: error }, 'Failed to record brand-book import cost'));

        const { usage: _usage, model: _model, ...body } = result;
        res.setHeader('Cache-Control', 'no-store');
        return res.json(body);
      } catch (error) {
        if (error instanceof BrandBookImportError) {
          return res.status(error.status).json({ error: error.message });
        }
        logger.error({ err: error }, 'Brand-book import failed');
        return res.status(502).json({ error: 'Brand-book import failed. Please try again.' });
      }
    },
  );

  return router;
}
