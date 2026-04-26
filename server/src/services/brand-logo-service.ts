/**
 * Brand logo service — shared validation, sanitization, and manifest rebuild logic.
 */

import crypto from 'crypto';
import { fileTypeFromBuffer } from 'file-type';
import DOMPurify from 'isomorphic-dompurify';
import sharp from 'sharp';
import { BrandLogoDatabase, type BrandLogoSummary } from '../db/brand-logo-db.js';
import { BrandDatabase } from '../db/brand-db.js';
import { getLogoUrl } from './logo-cdn.js';
import { safeFetch } from '../utils/url-security.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-logo-service');

const KNOWN_NON_IMAGE_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'dropbox.com',
  'www.dropbox.com',
]);

export interface LogoUrlCheck {
  ok: true;
  contentType: string;
}
export interface LogoUrlCheckError {
  ok: false;
  reason: string;
}

/**
 * Verify a public logo URL points to an actual image, not an HTML viewer or
 * an auth-walled file share. Catches the common Google Drive `/view?usp=...`
 * and Dropbox preview pages which silently serve HTML and render as a broken
 * image once stored. Issues a HEAD request through safeFetch (SSRF-protected)
 * with a short timeout so the save endpoint stays snappy.
 */
export async function checkLogoUrlIsImage(rawUrl: string): Promise<LogoUrlCheck | LogoUrlCheckError> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Logo URL is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Logo URL must use HTTPS.' };
  }
  if (KNOWN_NON_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      reason: `That ${parsed.hostname} link points to a file-viewer page, not the image itself. Paste a direct image URL instead — usually one ending in .png, .jpg, or .svg.`,
    };
  }

  const FETCH_TIMEOUT_MS = 5000;

  async function fetchWithTimeout(method: 'HEAD' | 'GET'): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Logo URL check timed out')), FETCH_TIMEOUT_MS);
    try {
      return await safeFetch(rawUrl, { method, maxRedirects: 3, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Cancel response bodies we never read so a malicious slow-body server
  // can't tie up a connection for the full timeout window.
  function discardBody(r: Response): void {
    r.body?.cancel().catch(() => {/* already closed or never opened */});
  }

  let response: Response;
  try {
    response = await fetchWithTimeout('HEAD');
  } catch (err) {
    return { ok: false, reason: `Could not reach the logo URL: ${err instanceof Error ? err.message : 'unknown error'}` };
  }

  // Some hosts reject HEAD with 405/501 — fall back to GET. Body is cancelled
  // immediately after we read the headers so we never buffer the image.
  if (response.status === 405 || response.status === 501) {
    discardBody(response);
    try {
      response = await fetchWithTimeout('GET');
    } catch (err) {
      return { ok: false, reason: `Could not reach the logo URL: ${err instanceof Error ? err.message : 'unknown error'}` };
    }
  }

  try {
    if (!response.ok) {
      return { ok: false, reason: `Logo URL returned HTTP ${response.status}. Make sure the URL is publicly accessible without authentication.` };
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
    if (!contentType) {
      return { ok: false, reason: 'Logo URL did not return a Content-Type header.' };
    }
    if (!contentType.startsWith('image/')) {
      return {
        ok: false,
        reason: `That URL returns ${contentType}, not an image. Paste a direct image URL — usually one ending in .png, .jpg, or .svg.`,
      };
    }

    return { ok: true, contentType };
  } finally {
    discardBody(response);
  }
}

export const ALLOWED_TAGS = new Set([
  // Variant
  'icon', 'wordmark', 'full-lockup', 'symbol', 'primary', 'secondary',
  // Shape
  'square', 'horizontal', 'vertical', 'stacked',
  // Background
  'light-bg', 'dark-bg', 'transparent-bg',
  // Use-case
  'favicon', 'social',
]);

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

export function validateLogoTags(tags: string[]): { valid: boolean; invalid: string[] } {
  const invalid = tags.filter(t => !ALLOWED_TAGS.has(t));
  return { valid: invalid.length === 0, invalid };
}

export async function detectContentType(buffer: Buffer): Promise<string | null> {
  const result = await fileTypeFromBuffer(buffer);
  if (result && ALLOWED_IMAGE_TYPES.has(result.mime)) {
    return result.mime;
  }

  // file-type returns undefined for SVG — check for XML/SVG markers
  const head = buffer.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) {
    return 'image/svg+xml';
  }

  return null;
}

export function sanitizeSvg(buffer: Buffer): Buffer {
  const raw = buffer.toString('utf8');
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: ['foreignObject', 'use', 'script', 'iframe', 'object', 'embed', 'animate', 'set', 'animateTransform'],
    FORBID_ATTR: ['xlink:href', 'href'],
  });
  return Buffer.from(clean, 'utf8');
}

export async function extractDimensions(
  buffer: Buffer,
  contentType: string,
): Promise<{ width?: number; height?: number }> {
  if (contentType === 'image/svg+xml') {
    return {};
  }
  try {
    const metadata = await sharp(buffer).metadata();
    return { width: metadata.width, height: metadata.height };
  } catch {
    return {};
  }
}

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Rebuild the brand_manifest.logos array for a domain using source priority ordering.
 * Community logos replace Brandfetch logos with matching or subset tags.
 */
export async function rebuildManifestLogos(
  domain: string,
  brandLogoDb: BrandLogoDatabase,
  brandDb: BrandDatabase,
): Promise<void> {
  const logos = await brandLogoDb.listBrandLogos(domain, { review_status: 'approved' });
  if (logos.length === 0) return;

  // Group by source priority: brand_owner > community > brandfetch
  const bySource: Record<string, BrandLogoSummary[]> = {
    brand_owner: [],
    community: [],
    brand_json: [],
    brandfetch: [],
  };
  for (const logo of logos) {
    (bySource[logo.source] || bySource.brandfetch).push(logo);
  }

  const higherPriority = [...bySource.brand_owner, ...bySource.community, ...bySource.brand_json];
  const brandfetch = bySource.brandfetch;

  // Filter out brandfetch logos whose tags are a subset of a higher-priority logo's tags.
  // Brandfetch logos with empty tags are never replaced (empty set is trivially a subset
  // of anything, which would incorrectly drop untagged logos).
  const keptBrandfetch = brandfetch.filter(bf => {
    if (bf.tags.length === 0) return true;
    const bfTags = new Set(bf.tags);
    return !higherPriority.some(hp => {
      if (hp.tags.length === 0) return false;
      const hpTags = new Set(hp.tags);
      for (const t of bfTags) {
        if (!hpTags.has(t)) return false;
      }
      return true;
    });
  });

  const finalLogos = [...higherPriority, ...keptBrandfetch];

  const manifestLogos = finalLogos.map(l => ({
    url: getLogoUrl(domain, l.id),
    tags: l.tags,
    ...(l.width ? { width: l.width } : {}),
    ...(l.height ? { height: l.height } : {}),
  }));

  try {
    const existing = await brandDb.getDiscoveredBrandByDomain(domain);
    if (!existing) {
      await brandDb.upsertDiscoveredBrand({
        domain,
        brand_manifest: { logos: manifestLogos },
        has_brand_manifest: true,
        source_type: 'community',
      });
    } else {
      await brandDb.editDiscoveredBrand(domain, {
        brand_manifest: { logos: manifestLogos },
        has_brand_manifest: true,
        edit_summary: 'Logo manifest rebuilt after review',
        editor_user_id: 'system:logo-service',
      });
    }
  } catch (err) {
    logger.error({ err, domain }, 'Failed to rebuild manifest logos');
  }
}
