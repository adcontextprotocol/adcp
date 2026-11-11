/**
 * Public brand logo assets: GET /assets/brands/:domain/:id.:ext and the legacy
 * GET /logos/brands/:domain/:id.
 *
 * Serves approved logos only. `?format=png&w=<width>` returns a PNG rendition
 * rasterised from the stored bytes; it never fetches a URL.
 */

import { Router, type Response } from 'express';
import { BrandLogoDatabase } from '../db/brand-logo-db.js';
import {
  extensionForLogoContentType,
  getBrandAssetUrl,
  getLogo,
  isAllowedLogoContentType,
} from '../services/logo-cdn.js';
import {
  canRasterizeLogo,
  LogoRenditionError,
  parseLogoRenditionQuery,
  renderLogoPng,
  type LogoRenditionWidth,
} from '../services/logo-rendition.js';
import { AsyncSemaphore, SemaphoreOverloadedError } from '../utils/async-semaphore.js';
import { isUuid } from '../utils/uuid.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-logo-assets');

const logoDomainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const assetPattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]+)$/i;

// A logo id names immutable bytes (a new upload is a new id), so originals and
// renditions share the same long public cache lifetime.
const LOGO_CACHE_CONTROL = 'public, max-age=2592000';

export interface BrandLogoAssetRouterOptions {
  /** In-process cache budget. Default ~100 MB. */
  cacheMaxBytes?: number;
  /** In-process cache TTL, so review-status changes take effect. Default 5 minutes. */
  cacheTtlMs?: number;
  /** Renditions rasterised at once. Default 4. */
  renderConcurrency?: number;
  /** Renditions allowed to wait for a slot before requests are shed. Default 32. */
  renderMaxQueued?: number;
}

interface CachedLogoEntry {
  content_type: string;
  /** Content type of the stored logo; differs from content_type for renditions. */
  source_content_type: string;
  data: Buffer;
  cachedAt: number;
}

export function createBrandLogoAssetRouter(options: BrandLogoAssetRouterOptions = {}): Router {
  const router = Router();
  const brandLogoDb = new BrandLogoDatabase();
  const cacheMaxBytes = options.cacheMaxBytes ?? 100 * 1024 * 1024;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const renderSemaphore = new AsyncSemaphore(
    options.renderConcurrency ?? 4,
    options.renderMaxQueued ?? 32,
  );

  // LRU cache of originals and renditions, keyed by domain, id, format and width.
  const logoCache = new Map<string, CachedLogoEntry>();
  let logoCacheTotalBytes = 0;

  function evictLogoCache(): void {
    const now = Date.now();
    // Evict expired entries first
    for (const [key, entry] of logoCache) {
      if (now - entry.cachedAt > cacheTtlMs) {
        logoCacheTotalBytes -= entry.data.length;
        logoCache.delete(key);
      }
    }
    // Evict oldest entries until under budget
    while (logoCacheTotalBytes > cacheMaxBytes && logoCache.size > 0) {
      const firstKey = logoCache.keys().next().value!;
      const entry = logoCache.get(firstKey)!;
      logoCacheTotalBytes -= entry.data.length;
      logoCache.delete(firstKey);
    }
  }

  function cacheLogo(key: string, entry: CachedLogoEntry): void {
    const previous = logoCache.get(key);
    if (previous) {
      logoCacheTotalBytes -= previous.data.length;
      logoCache.delete(key);
    }
    logoCacheTotalBytes += entry.data.length;
    logoCache.set(key, entry);
    evictLogoCache();
  }

  function sendLogo(res: Response, contentType: string, data: Buffer) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', LOGO_CACHE_CONTROL);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Content-Disposition', 'inline');
    return res.send(data);
  }

  const serveApprovedLogoAsset = async (
    domain: string,
    id: string,
    query: Record<string, unknown>,
    res: Response,
    requestedExt?: string,
  ) => {
    if (!logoDomainPattern.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain' });
    }
    if (!isUuid(id)) {
      return res.status(400).json({ error: 'Invalid logo ID' });
    }
    const parsed = parseLogoRenditionQuery(query);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const rendition = parsed.rendition;
    const renditionQuery = rendition ? `?format=png&w=${rendition.width}` : '';
    const redirectToCanonicalAsset = (contentType: string) =>
      res.redirect(301, `${getBrandAssetUrl(domain, id, contentType)}${renditionQuery}`);

    try {
      // Check LRU cache (with TTL)
      const cacheKey = `${domain}/${id}${renditionQuery}`;
      const cached = logoCache.get(cacheKey);
      if (cached && (Date.now() - cached.cachedAt) < cacheTtlMs) {
        // Move to end (most recently used)
        logoCache.delete(cacheKey);
        logoCache.set(cacheKey, cached);

        const expectedExt = extensionForLogoContentType(cached.source_content_type);
        if (requestedExt && requestedExt.toLowerCase() !== expectedExt) {
          return redirectToCanonicalAsset(cached.source_content_type);
        }
        return sendLogo(res, cached.content_type, cached.data);
      }

      const logo = await getLogo(domain, id);
      if (!logo) {
        return res.status(404).json({ error: 'Logo not found' });
      }
      if (!isAllowedLogoContentType(logo.content_type)) {
        logger.error({ domain, id, contentType: logo.content_type }, 'Logo has disallowed content-type');
        return res.status(500).json({ error: 'Failed to retrieve logo' });
      }
      const expectedExt = extensionForLogoContentType(logo.content_type);
      if (requestedExt && requestedExt.toLowerCase() !== expectedExt) {
        return redirectToCanonicalAsset(logo.content_type);
      }

      if (!rendition) {
        cacheLogo(cacheKey, {
          content_type: logo.content_type,
          source_content_type: logo.content_type,
          data: logo.data,
          cachedAt: Date.now(),
        });
        return sendLogo(res, logo.content_type, logo.data);
      }

      if (!canRasterizeLogo(logo.content_type)) {
        return res.status(415).json({ error: `A ${logo.content_type} logo has no PNG rendition` });
      }
      const width: LogoRenditionWidth = rendition.width;
      const png = await renderSemaphore.run(() => renderLogoPng(logo.data, logo.content_type, width));
      cacheLogo(cacheKey, {
        content_type: 'image/png',
        source_content_type: logo.content_type,
        data: png,
        cachedAt: Date.now(),
      });
      return sendLogo(res, 'image/png', png);
    } catch (error) {
      if (error instanceof SemaphoreOverloadedError) {
        logger.warn({ domain, id }, 'Logo rendition shed load');
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: 'Logo rendering is busy. Retry shortly.' });
      }
      if (error instanceof LogoRenditionError) {
        logger.warn({ err: error, domain, id }, 'Logo rendition failed');
        return error.reason === 'unsupported'
          ? res.status(415).json({ error: 'This logo has no PNG rendition' })
          : res.status(422).json({ error: 'This logo could not be rendered as PNG' });
      }
      logger.error({ err: error, domain, id }, 'Failed to serve logo');
      return res.status(500).json({ error: 'Failed to retrieve logo' });
    }
  };

  router.get('/assets/brands/:domain/:asset', async (req, res) => {
    const domain = req.params.domain.toLowerCase();
    const match = assetPattern.exec(req.params.asset);
    if (!match) {
      return res.status(400).json({ error: 'Invalid asset ID' });
    }
    return serveApprovedLogoAsset(domain, match[1], req.query, res, match[2]);
  });

  router.get('/logos/brands/:domain/:id', async (req, res) => {
    const domain = req.params.domain.toLowerCase();
    const id = req.params.id;

    // Integer fallback: old /:idx URLs redirect to UUID.
    if (/^\d+$/.test(id)) {
      const oldIdx = parseInt(id, 10);
      const newId = await brandLogoDb.getLogoRedirect(domain, oldIdx);
      if (!newId) {
        return res.status(404).json({ error: 'Logo not found' });
      }
      const parsed = parseLogoRenditionQuery(req.query);
      const renditionQuery = parsed.ok && parsed.rendition ? `?format=png&w=${parsed.rendition.width}` : '';
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Content-Disposition', 'inline');
      return res.redirect(301, `/logos/brands/${domain}/${newId}${renditionQuery}`);
    }

    return serveApprovedLogoAsset(domain, id, req.query, res);
  });

  return router;
}
