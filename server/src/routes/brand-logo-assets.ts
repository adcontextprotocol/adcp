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
  LOGO_RENDER_CONCURRENCY,
  LOGO_RENDER_MAX_QUEUED,
  logoRenderLimiter,
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
  /**
   * Renditions rasterised at once. Setting this or renderMaxQueued gives the
   * router its own limiter (for tests); by default it shares the
   * process-wide logoRenderLimiter (2 at once) with the background backfill.
   */
  renderConcurrency?: number;
  /** Renditions allowed to wait for a slot before requests are shed. Default 32. */
  renderMaxQueued?: number;
}

type CachedLogoEntry =
  | {
    kind: 'logo';
    content_type: string;
    /** Content type of the stored logo; differs from content_type for renditions. */
    source_content_type: string;
    data: Buffer;
    cachedAt: number;
  }
  | {
    /** A rendition that cannot be produced (415/422), cached so it is not retried per request. */
    kind: 'failure';
    status: 415 | 422;
    error: string;
    source_content_type: string;
    cachedAt: number;
  };

/** What a cached failure counts against the byte budget. */
const FAILURE_ENTRY_BYTES = 256;

function entryBytes(entry: CachedLogoEntry): number {
  return entry.kind === 'logo' ? entry.data.length : FAILURE_ENTRY_BYTES;
}

class DisallowedLogoContentTypeError extends Error {}

/** Errors are never cached: by us, by browsers, or by the CDN in front. */
function sendError(res: Response, status: number, error: string) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error });
}

export function createBrandLogoAssetRouter(options: BrandLogoAssetRouterOptions = {}): Router {
  const router = Router();
  const brandLogoDb = new BrandLogoDatabase();
  const cacheMaxBytes = options.cacheMaxBytes ?? 100 * 1024 * 1024;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const renderSemaphore =
    options.renderConcurrency !== undefined || options.renderMaxQueued !== undefined
      ? new AsyncSemaphore(
        options.renderConcurrency ?? LOGO_RENDER_CONCURRENCY,
        options.renderMaxQueued ?? LOGO_RENDER_MAX_QUEUED,
      )
      : logoRenderLimiter;

  // LRU cache of originals, renditions and rendition failures, keyed by
  // domain, id, format and width.
  const logoCache = new Map<string, CachedLogoEntry>();
  let logoCacheTotalBytes = 0;
  // Loads in progress, by cache key, so concurrent misses share one read and
  // one render.
  const inflight = new Map<string, Promise<CachedLogoEntry | null>>();

  function evictLogoCache(): void {
    const now = Date.now();
    // Evict expired entries first
    for (const [key, entry] of logoCache) {
      if (now - entry.cachedAt > cacheTtlMs) {
        logoCacheTotalBytes -= entryBytes(entry);
        logoCache.delete(key);
      }
    }
    // Evict oldest entries until under budget
    while (logoCacheTotalBytes > cacheMaxBytes && logoCache.size > 0) {
      const firstKey = logoCache.keys().next().value!;
      const entry = logoCache.get(firstKey)!;
      logoCacheTotalBytes -= entryBytes(entry);
      logoCache.delete(firstKey);
    }
  }

  function cacheLogo(key: string, entry: CachedLogoEntry): void {
    const previous = logoCache.get(key);
    if (previous) {
      logoCacheTotalBytes -= entryBytes(previous);
      logoCache.delete(key);
    }
    logoCacheTotalBytes += entryBytes(entry);
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

  /** The cache entry for a stored logo, or a rendition of it. */
  async function buildEntry(
    domain: string,
    id: string,
    logo: { content_type: string; data: Buffer },
    rendition: { width: LogoRenditionWidth } | null,
  ): Promise<CachedLogoEntry> {
    const base = { source_content_type: logo.content_type, cachedAt: Date.now() };
    if (!rendition) {
      return { kind: 'logo', ...base, content_type: logo.content_type, data: logo.data };
    }
    if (!canRasterizeLogo(logo.content_type)) {
      return { kind: 'failure', ...base, status: 415, error: `A ${logo.content_type} logo has no PNG rendition` };
    }
    try {
      const png = await renderSemaphore.run(() => renderLogoPng(logo.data, logo.content_type, rendition.width));
      return { kind: 'logo', ...base, cachedAt: Date.now(), content_type: 'image/png', data: png };
    } catch (error) {
      if (!(error instanceof LogoRenditionError)) throw error;
      logger.warn({ err: error, domain, id }, 'Logo rendition failed');
      return error.reason === 'unsupported'
        ? { kind: 'failure', ...base, status: 415, error: 'This logo has no PNG rendition' }
        : { kind: 'failure', ...base, status: 422, error: 'This logo could not be rendered as PNG' };
    }
  }

  /**
   * Read (and render) the entry for a cache key, caching the outcome.
   * Concurrent calls for one key share a single load. Null: not found.
   */
  function loadEntry(
    domain: string,
    id: string,
    rendition: { width: LogoRenditionWidth } | null,
    cacheKey: string,
  ): Promise<CachedLogoEntry | null> {
    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    const load = (async () => {
      const logo = await getLogo(domain, id);
      if (!logo) return null;
      if (!isAllowedLogoContentType(logo.content_type)) {
        logger.error({ domain, id, contentType: logo.content_type }, 'Logo has disallowed content-type');
        throw new DisallowedLogoContentTypeError();
      }
      const entry = await buildEntry(domain, id, logo, rendition);
      cacheLogo(cacheKey, entry);
      return entry;
    })().finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, load);
    return load;
  }

  const serveApprovedLogoAsset = async (
    domain: string,
    id: string,
    query: Record<string, unknown>,
    res: Response,
    requestedExt?: string,
  ) => {
    if (!logoDomainPattern.test(domain)) {
      return sendError(res, 400, 'Invalid domain');
    }
    if (!isUuid(id)) {
      return sendError(res, 400, 'Invalid logo ID');
    }
    const parsed = parseLogoRenditionQuery(query);
    if (!parsed.ok) {
      return sendError(res, 400, parsed.error);
    }
    const rendition = parsed.rendition;
    const renditionQuery = rendition ? `?format=png&w=${rendition.width}` : '';
    const cacheKey = `${domain}/${id}${renditionQuery}`;

    try {
      let entry: CachedLogoEntry | null | undefined = logoCache.get(cacheKey);
      if (entry && (Date.now() - entry.cachedAt) < cacheTtlMs) {
        // Move to end (most recently used)
        logoCache.delete(cacheKey);
        logoCache.set(cacheKey, entry);
      } else {
        entry = await loadEntry(domain, id, rendition, cacheKey);
      }
      if (!entry) {
        return sendError(res, 404, 'Logo not found');
      }

      const expectedExt = extensionForLogoContentType(entry.source_content_type);
      if (requestedExt && requestedExt.toLowerCase() !== expectedExt) {
        return res.redirect(301, `${getBrandAssetUrl(domain, id, entry.source_content_type)}${renditionQuery}`);
      }
      if (entry.kind === 'failure') {
        return sendError(res, entry.status, entry.error);
      }
      return sendLogo(res, entry.content_type, entry.data);
    } catch (error) {
      if (error instanceof SemaphoreOverloadedError) {
        logger.warn({ domain, id }, 'Logo rendition shed load');
        res.setHeader('Retry-After', '5');
        return sendError(res, 503, 'Logo rendering is busy. Retry shortly.');
      }
      if (!(error instanceof DisallowedLogoContentTypeError)) {
        logger.error({ err: error, domain, id }, 'Failed to serve logo');
      }
      return sendError(res, 500, 'Failed to retrieve logo');
    }
  };

  router.get('/assets/brands/:domain/:asset', async (req, res) => {
    const domain = req.params.domain.toLowerCase();
    const match = assetPattern.exec(req.params.asset);
    if (!match) {
      return sendError(res, 400, 'Invalid asset ID');
    }
    return serveApprovedLogoAsset(domain, match[1], req.query, res, match[2]);
  });

  router.get('/logos/brands/:domain/:id', async (req, res) => {
    const domain = req.params.domain.toLowerCase();
    const id = req.params.id;

    // Integer fallback: old /:idx URLs redirect to UUID.
    if (/^\d+$/.test(id)) {
      const oldIdx = parseInt(id, 10);
      let newId: string | null;
      try {
        newId = await brandLogoDb.getLogoRedirect(domain, oldIdx);
      } catch (error) {
        logger.error({ err: error, domain, oldIdx }, 'Failed to resolve legacy logo id');
        return sendError(res, 500, 'Failed to retrieve logo');
      }
      if (!newId) {
        return sendError(res, 404, 'Logo not found');
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
