/**
 * Brand identity update service.
 *
 * Shared by:
 *  - PUT /api/me/member-profile/brand-identity (member self-service via web UI)
 *  - update_company_logo Addie tool (member self-service via chat)
 *  - update_member_logo Addie tool (admin acting on behalf of a member)
 *
 * Centralizes brand-domain canonicalization, logo URL validation, and the
 * brands+member_profiles transaction so all three paths produce identical
 * brand_manifest shapes and stay in sync.
 */

import { getPool } from '../db/client.js';
import { canonicalizeBrandDomain, assertValidBrandDomain } from './identifier-normalization.js';
import { checkLogoUrlIsImage } from './brand-logo-service.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-identity');

export interface UpdateBrandIdentityInput {
  /** WorkOS organization id that owns the profile (used as ownership boundary on the brands row). */
  workosOrganizationId: string;
  /** Display name used when minting a new brand record. */
  displayName: string;
  /** Member profile, if one exists. Required for primary_brand_domain link-back. */
  profile?: {
    id: string;
    primary_brand_domain?: string;
    contact_website?: string;
  } | null;
  /** New logo URL. HTTPS, must HEAD-resolve to image/*. Pass undefined to leave unchanged. */
  logoUrl?: string | null;
  /** New primary brand color. #RRGGBB. Pass undefined to leave unchanged. */
  brandColor?: string | null;
  /** Domain hint used when the profile has no primary_brand_domain yet (e.g., logo URL hostname). */
  fallbackDomainHint?: string;
}

export interface UpdateBrandIdentityResult {
  brandDomain: string;
  wasUpdate: boolean;
}

export class BrandIdentityError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'BrandIdentityError';
  }
}

export async function updateBrandIdentity(
  input: UpdateBrandIdentityInput,
): Promise<UpdateBrandIdentityResult> {
  const { profile, workosOrganizationId, displayName, logoUrl, brandColor, fallbackDomainHint } = input;

  if (logoUrl === undefined && brandColor === undefined) {
    throw new BrandIdentityError(400, 'Provide at least one of logo_url or brand_color.');
  }

  if (logoUrl) {
    if (logoUrl.length > 2000) {
      throw new BrandIdentityError(400, 'Logo URL must be 2000 characters or less.');
    }
    const check = await checkLogoUrlIsImage(logoUrl);
    if (!check.ok) {
      throw new BrandIdentityError(400, check.reason);
    }
  }

  if (brandColor && !/^#[0-9a-fA-F]{6}$/.test(brandColor)) {
    throw new BrandIdentityError(400, 'Brand color must be a hex color (e.g., #FF5733).');
  }

  // Pick a brand domain. Prefer the profile's, fall back to website hostname,
  // then to a hint from the caller (typically the logo URL hostname).
  let brandDomain = profile?.primary_brand_domain ?? undefined;
  if (!brandDomain && profile?.contact_website) {
    try { brandDomain = new URL(profile.contact_website).hostname; } catch { /* ignore */ }
  }
  if (!brandDomain && fallbackDomainHint) {
    brandDomain = fallbackDomainHint;
  }
  if (!brandDomain) {
    throw new BrandIdentityError(400, 'No brand domain set. Add your website to your profile first.');
  }
  brandDomain = canonicalizeBrandDomain(brandDomain);
  try {
    assertValidBrandDomain(brandDomain);
  } catch (err) {
    throw new BrandIdentityError(400, err instanceof Error ? err.message : 'Invalid brand domain.');
  }

  const pool = getPool();
  const client = await pool.connect();
  let wasUpdate = false;
  try {
    await client.query('BEGIN');

    const existingResult = await client.query<{ id: string; workos_organization_id: string | null; brand_json: Record<string, unknown> }>(
      'SELECT id, workos_organization_id, brand_manifest AS brand_json FROM brands WHERE domain = $1 FOR UPDATE',
      [brandDomain]
    );
    const existing = existingResult.rows[0] ?? null;
    wasUpdate = !!existing;

    // Ownership boundary: don't let one org overwrite another's brand
    if (existing && existing.workos_organization_id && existing.workos_organization_id !== workosOrganizationId) {
      throw new BrandIdentityError(403, 'This brand domain is managed by another organization.');
    }

    if (existing) {
      const bj = applyToBrandJson(existing.brand_json ?? {}, displayName, logoUrl, brandColor);
      await client.query(
        'UPDATE brands SET brand_manifest = $1, workos_organization_id = COALESCE(workos_organization_id, $3), updated_at = NOW() WHERE id = $2',
        [JSON.stringify(bj), existing.id, workosOrganizationId]
      );
    } else {
      const bj = applyToBrandJson({
        house: { domain: brandDomain, name: displayName },
      }, displayName, logoUrl, brandColor);
      // Attribute brand_owner source when the org has verified domain ownership
      const hostedResult = await client.query<{ domain_verified: boolean }>(
        'SELECT domain_verified FROM hosted_brands WHERE domain = $1 AND workos_organization_id = $2 LIMIT 1',
        [brandDomain, workosOrganizationId]
      );
      const sourceType = hostedResult.rows[0]?.domain_verified ? 'brand_owner' : 'community';
      await client.query(
        `INSERT INTO brands (workos_organization_id, domain, brand_manifest, brand_name, source_type, review_status, is_public, has_brand_manifest)
         VALUES ($1, $2, $3, COALESCE($3::jsonb->>'name', $2), $5, 'approved', $4, true)
         ON CONFLICT (domain) DO UPDATE SET
           brand_manifest = COALESCE(EXCLUDED.brand_manifest, brands.brand_manifest),
           workos_organization_id = COALESCE(EXCLUDED.workos_organization_id, brands.workos_organization_id),
           is_public = COALESCE(EXCLUDED.is_public, brands.is_public),
           has_brand_manifest = true,
           updated_at = NOW()`,
        [workosOrganizationId, brandDomain, JSON.stringify(bj), true, sourceType]
      );
    }

    if (profile && profile.primary_brand_domain !== brandDomain) {
      await client.query(
        'UPDATE member_profiles SET primary_brand_domain = $1, updated_at = NOW() WHERE id = $2',
        [brandDomain, profile.id]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  logger.info({ profileId: profile?.id, brandDomain, wasUpdate, hasLogo: !!logoUrl, hasColor: !!brandColor }, 'Brand identity updated');
  return { brandDomain, wasUpdate };
}


/**
 * Apply logo + color updates to a brand_manifest, preserving everything else.
 * Always writes to brands[0].logos[0].url and brands[0].colors.primary so the
 * canonical resolver picks them up regardless of input shape.
 */
function applyToBrandJson(
  source: Record<string, unknown>,
  displayName: string,
  logoUrl: string | null | undefined,
  brandColor: string | null | undefined,
): Record<string, unknown> {
  const bj = { ...source };
  const brands = (bj.brands as Array<Record<string, unknown>> | undefined) ?? [];

  let primaryBrand: Record<string, unknown>;
  if (brands.length > 0) {
    primaryBrand = { ...brands[0] };
  } else {
    primaryBrand = {
      id: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      names: [{ en: displayName }],
    };
  }

  if (logoUrl !== undefined && logoUrl !== null) {
    const existingLogos = (primaryBrand.logos as Array<Record<string, unknown>> | undefined) ?? [];
    primaryBrand.logos = existingLogos.length > 0
      ? [{ ...existingLogos[0], url: logoUrl }, ...existingLogos.slice(1)]
      : [{ url: logoUrl }];
  }

  if (brandColor !== undefined && brandColor !== null) {
    const existingColors = (primaryBrand.colors as Record<string, unknown> | undefined) ?? {};
    primaryBrand.colors = { ...existingColors, primary: brandColor };
  }

  bj.brands = [primaryBrand, ...brands.slice(1)];
  return bj;
}

