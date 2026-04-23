/**
 * Resolves the visual that accompanies a new-member announcement.
 *
 * - Company tiers: the brand.json logo. If absent, AAO fallback mark.
 * - Individual tiers: the approved member portrait. If absent, AAO fallback.
 *
 * Never falls back to third-party logo sources (Brandfetch etc.) — consent
 * principle: "Visual is theirs."
 *
 * Brand.json URLs are third-party-authored. Every candidate logo URL is
 * validated before it leaves this module: https-only, public host only,
 * whitelisted raster image extensions (no svg — it can carry script).
 * On any failure the resolver falls back to the AAO mark rather than
 * posting an attacker-chosen URL into a Slack review channel.
 */

import { createLogger } from '../logger.js';
import { query } from '../db/client.js';

const logger = createLogger('announcement-visual');

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

/** Absolute URL to AAO's fallback mark. */
export const AAO_FALLBACK_VISUAL_URL = `${APP_URL}/AAo-social.png`;

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_VISUAL_URL_LENGTH = 2048;

/**
 * Returns `true` when `url` is safe to hand to Slack as an `image_url`:
 *  - Parses as an absolute URL.
 *  - Scheme is https.
 *  - Host is not localhost, a loopback IP, or an RFC1918 private range.
 *  - Pathname ends in an allowlisted raster extension (svg intentionally
 *    excluded — Slack won't execute script but downstream surfaces
 *    (LinkedIn paste, profile page) might).
 */
export function isSafeVisualUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_VISUAL_URL_LENGTH) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost') return false;
  if (host.startsWith('127.') || host === '0.0.0.0' || host === '::1') return false;
  if (host.startsWith('10.') || host.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.endsWith('.internal') || host.endsWith('.local')) return false;
  const lastDot = parsed.pathname.lastIndexOf('.');
  if (lastDot < 0) return false;
  const ext = parsed.pathname.slice(lastDot).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) return false;
  return true;
}

export interface VisualResolution {
  url: string;
  altText: string;
  source: 'brand_logo' | 'member_portrait' | 'aao_fallback';
}

function isCompanyTier(tier: string | null | undefined): boolean {
  return tier === 'company_standard' || tier === 'company_icl';
}

function isIndividualTier(tier: string | null | undefined): boolean {
  return tier === 'individual_professional' || tier === 'individual_academic';
}

/**
 * Pull the first logo URL out of a brand.json manifest. Supports both the
 * top-level shape (`logos[0].url`) and the multi-brand variant
 * (`brands[0].logos[0].url`).
 */
export function extractLogoFromManifest(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const m = manifest as Record<string, unknown>;

  const topLogos = m.logos;
  if (Array.isArray(topLogos) && topLogos.length > 0) {
    const first = topLogos[0];
    if (first && typeof first === 'object' && typeof (first as { url?: unknown }).url === 'string') {
      return (first as { url: string }).url;
    }
  }

  const brands = m.brands;
  if (Array.isArray(brands) && brands.length > 0) {
    const firstBrand = brands[0];
    if (firstBrand && typeof firstBrand === 'object') {
      const inner = (firstBrand as { logos?: unknown }).logos;
      if (Array.isArray(inner) && inner.length > 0) {
        const first = inner[0];
        if (first && typeof first === 'object' && typeof (first as { url?: unknown }).url === 'string') {
          return (first as { url: string }).url;
        }
      }
    }
  }

  return null;
}

async function fetchBrandLogoByDomain(domain: string): Promise<string | null> {
  const result = await query<{ logo_url: string | null }>(
    `SELECT COALESCE(
        brand_manifest->'logos'->0->>'url',
        brand_manifest->'brands'->0->'logos'->0->>'url'
     ) AS logo_url
     FROM brands
     WHERE domain = LOWER($1) AND brand_manifest IS NOT NULL
     LIMIT 1`,
    [domain],
  );
  const raw = result.rows[0]?.logo_url ?? null;
  if (!raw) return null;
  if (!isSafeVisualUrl(raw)) {
    logger.warn({ domain, reason: 'unsafe_visual_url' }, 'Rejected brand.json logo URL');
    return null;
  }
  return raw;
}

async function fetchApprovedPortraitUrlByOrg(orgId: string): Promise<string | null> {
  const result = await query<{ image_url: string | null }>(
    `SELECT p.image_url
     FROM member_portraits p
     JOIN member_profiles mp ON mp.portrait_id = p.id
     WHERE mp.workos_organization_id = $1
       AND p.status = 'approved'
     ORDER BY p.approved_at DESC NULLS LAST, p.created_at DESC
     LIMIT 1`,
    [orgId],
  );
  return result.rows[0]?.image_url ?? null;
}

export interface VisualResolveInputs {
  workosOrganizationId: string;
  membershipTier: string | null;
  primaryBrandDomain: string | null;
  displayName: string;
}

export async function resolveAnnouncementVisual(
  input: VisualResolveInputs,
): Promise<VisualResolution> {
  if (isCompanyTier(input.membershipTier) && input.primaryBrandDomain) {
    const logoUrl = await fetchBrandLogoByDomain(input.primaryBrandDomain);
    if (logoUrl) {
      return {
        url: logoUrl,
        altText: `${input.displayName} logo`,
        source: 'brand_logo',
      };
    }
  }

  if (isIndividualTier(input.membershipTier)) {
    const portraitUrl = await fetchApprovedPortraitUrlByOrg(input.workosOrganizationId);
    if (portraitUrl) {
      return {
        url: portraitUrl,
        altText: `${input.displayName} portrait`,
        source: 'member_portrait',
      };
    }
  }

  return {
    url: AAO_FALLBACK_VISUAL_URL,
    altText: 'AgenticAdvertising.org',
    source: 'aao_fallback',
  };
}
