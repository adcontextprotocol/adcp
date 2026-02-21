/**
 * Brand logo CDN
 *
 * Downloads logo images from external sources (e.g. Brandfetch CDN) and stores
 * them in PostgreSQL so they can be served from our own endpoint. This avoids
 * hotlinking restrictions that block external agents from downloading logos directly.
 */

import axios from 'axios';
import { query } from '../db/client.js';
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

export function getLogoUrl(domain: string, idx: number): string {
  return `${BASE_URL}/logos/brands/${encodeURIComponent(domain)}/${idx}`;
}

export function isBrandfetchUrl(url: string): boolean {
  return url.includes('cdn.brandfetch.io') || url.includes('brandfetch.io');
}

function isSafeLogoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!parsed.hostname.endsWith('brandfetch.io')) return false;
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

export async function getCachedLogo(domain: string, idx: number): Promise<CachedLogo | null> {
  const result = await query<{ content_type: string; data: Buffer }>(
    'SELECT content_type, data FROM brand_logo_cache WHERE domain = $1 AND idx = $2',
    [domain, idx]
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
        timeout: 10000,
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

      const data = Buffer.from(response.data);

      await query(
        `INSERT INTO brand_logo_cache (domain, idx, content_type, data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (domain, idx) DO UPDATE
           SET content_type = EXCLUDED.content_type,
               data = EXCLUDED.data,
               fetched_at = now()`,
        [domain, i, contentType, data]
      );

      updated.push({ url: getLogoUrl(domain, i), tags: logo.tags });
      logger.debug({ domain, idx: i, bytes: data.length }, 'Logo cached');
    } catch (err) {
      logger.warn({ err, domain, idx: i, url: logo.url }, 'Failed to download logo, keeping original URL');
      updated.push(logo);
    }
  }

  return updated;
}
