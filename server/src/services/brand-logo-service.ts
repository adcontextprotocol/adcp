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
import { createLogger } from '../logger.js';

const logger = createLogger('brand-logo-service');

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

  return result ? null : null;
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
    // Ensure the discovered brand exists before updating the manifest
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
