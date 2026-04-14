/**
 * Brand logo CDN
 *
 * Downloads logo images from external sources (e.g. Brandfetch CDN) and stores
 * them in PostgreSQL so they can be served from our own endpoint. This avoids
 * hotlinking restrictions that block external agents from downloading logos directly.
 */

import axios from 'axios';
import crypto from 'crypto';
import { query } from '../db/client.js';
import { BrandLogoDatabase } from '../db/brand-logo-db.js';
import { sanitizeSvg } from './brand-logo-service.js';
import { createLogger } from '../logger.js';

const logger = createLogger('logo-cdn');

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB
const LOGO_DOWNLOAD_TIMEOUT_MS = 30_000; // 30 seconds

const brandLogoDb = new BrandLogoDatabase();

export function getLogoUrl(domain: string, logoId: string): string {
  return `${BASE_URL}/logos/brands/${encodeURIComponent(domain)}/${logoId}`;
}

export function isBrandfetchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'cdn.brandfetch.io' || parsed.hostname.endsWith('.brandfetch.io') || parsed.hostname === 'brandfetch.io';
  } catch {
    return false;
  }
}

function isSafeLogoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.hostname !== 'brandfetch.io' && !parsed.hostname.endsWith('.brandfetch.io')) return false;
    return true;
  } catch {
    return false;
  }
}

function sanitizeContentType(raw: string, url: string): string | null {
  const base = raw.split(';')[0].trim().toLowerCase();
  if (ALLOWED_CONTENT_TYPES.has(base)) return base;
  // SVG URL heuristic as fallback when server returns wrong content-type
  if (url.includes('.svg')) return 'image/svg+xml';
  return null;
}

export interface CachedLogo {
  content_type: string;
  data: Buffer;
}

export function isAllowedLogoContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType);
}

export async function getLogo(domain: string, logoId: string): Promise<CachedLogo | null> {
  const result = await query<{ content_type: string; data: Buffer }>(
    `SELECT content_type, data FROM brand_logos
     WHERE domain = $1 AND id = $2 AND review_status = 'approved'`,
    [domain, logoId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

/**
 * Download logos from external URLs, store in DB, and return updated logo array with our hosted URLs.
 * Only fetches from brandfetch.io domains. Logos that fail to download keep their original URL.
 */
export async function downloadAndCacheLogos(
  domain: string,
  logos: Array<{ url: string; tags: string[] }>
): Promise<Array<{ url: string; tags: string[] }>> {
  const updated: Array<{ url: string; tags: string[] }> = [];

  for (let i = 0; i < logos.length; i++) {
    const logo = logos[i];

    if (!isSafeLogoUrl(logo.url)) {
      logger.warn({ domain, idx: i, url: logo.url }, 'Logo URL not from brandfetch.io, skipping download');
      updated.push(logo);
      continue;
    }

    try {
      const response = await axios.get<ArrayBuffer>(logo.url, {
        responseType: 'arraybuffer',
        timeout: LOGO_DOWNLOAD_TIMEOUT_MS,
        maxContentLength: MAX_LOGO_BYTES,
        maxBodyLength: MAX_LOGO_BYTES,
        headers: { 'User-Agent': 'AgenticAdvertising/1.0' },
        validateStatus: (status) => status === 200,
      });

      const rawContentType = (response.headers['content-type'] as string) || '';
      const contentType = sanitizeContentType(rawContentType, logo.url);
      if (!contentType) {
        logger.warn({ domain, idx: i, rawContentType }, 'Logo has disallowed content-type, skipping');
        updated.push(logo);
        continue;
      }

      const rawData = Buffer.from(response.data);
      const data = contentType === 'image/svg+xml' ? sanitizeSvg(rawData) : rawData;
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');

      const inserted = await brandLogoDb.insertBrandLogo({
        domain,
        content_type: contentType,
        data,
        sha256,
        tags: logo.tags || [],
        source: 'brandfetch',
        review_status: 'approved',
      });

      if (inserted) {
        updated.push({ url: getLogoUrl(domain, inserted.id), tags: logo.tags });
        logger.debug({ domain, logoId: inserted.id, bytes: data.length }, 'Logo cached');
      } else {
        // Dedup conflict — find existing logo by sha256
        const existing = await brandLogoDb.getByDomainAndSha256(domain, sha256);
        if (existing) {
          updated.push({ url: getLogoUrl(domain, existing.id), tags: logo.tags });
        } else {
          updated.push(logo);
        }
      }
    } catch (err) {
      logger.warn({ err, domain, idx: i, url: logo.url }, 'Failed to download logo, keeping original URL');
      updated.push(logo);
    }
  }

  return updated;
}
