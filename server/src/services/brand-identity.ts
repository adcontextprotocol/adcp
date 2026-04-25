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
  /**
   * When the brand row is orphaned (prior owner relinquished, manifest
   * preserved) and this caller is the new claimant: when true, keep the
   * prior brand_manifest as the starting point and merge new logo/color
   * over it. When false (default), clear the prior manifest and start
   * fresh. Either way the orphan flag is cleared at write time.
   */
  adoptPriorManifest?: boolean;
}

export interface UpdateBrandIdentityResult {
  brandDomain: string;
  wasUpdate: boolean;
  /** True when this call adopted (or cleared) an orphaned manifest. */
  adoptedOrphanedManifest?: boolean;
}

export type BrandIdentityErrorCode =
  | 'invalid_input'        // 400-class: bad logo URL, invalid color, etc.
  | 'invalid_domain'       // 400-class: domain canonicalizes to garbage
  | 'no_brand_domain'      // 400-class: caller has no domain to write to
  | 'cross_org_ownership'; // 403-class: domain owned by a different org

/** Per-code meta payload shapes. Add a new code by extending this map. */
export interface BrandIdentityErrorMetaByCode {
  invalid_input: undefined;
  invalid_domain: { canonicalDomain: string };
  no_brand_domain: undefined;
  cross_org_ownership: { brandDomain: string; currentOwnerOrgId: string };
}

export class BrandIdentityError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: BrandIdentityErrorCode = 'invalid_input',
    public readonly meta?: BrandIdentityErrorMetaByCode[BrandIdentityErrorCode],
  ) {
    super(message);
    this.name = 'BrandIdentityError';
  }

  /**
   * Type guard that narrows both the discriminator and the meta payload —
   * use this in catch sites instead of comparing `err.code` directly so
   * callers get `err.meta.brandDomain` typed as string instead of unknown.
   */
  isCrossOrgOwnership(): this is BrandIdentityError & {
    code: 'cross_org_ownership';
    meta: BrandIdentityErrorMetaByCode['cross_org_ownership'];
  } {
    return this.code === 'cross_org_ownership';
  }
}

export async function updateBrandIdentity(
  input: UpdateBrandIdentityInput,
): Promise<UpdateBrandIdentityResult> {
  const { profile, workosOrganizationId, displayName, logoUrl, brandColor, fallbackDomainHint, adoptPriorManifest } = input;

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
    throw new BrandIdentityError(400, 'No brand domain set. Add your website to your profile first.', 'no_brand_domain');
  }
  brandDomain = canonicalizeBrandDomain(brandDomain);
  try {
    assertValidBrandDomain(brandDomain);
  } catch (err) {
    throw new BrandIdentityError(
      400,
      err instanceof Error ? err.message : 'Invalid brand domain.',
      'invalid_domain',
      { canonicalDomain: brandDomain },
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  let wasUpdate = false;
  let adoptedOrphanedManifest = false;
  try {
    await client.query('BEGIN');

    const existingResult = await client.query<{
      id: string;
      workos_organization_id: string | null;
      brand_json: Record<string, unknown>;
      manifest_orphaned: boolean | null;
    }>(
      `SELECT id, workos_organization_id, brand_manifest AS brand_json, manifest_orphaned
       FROM brands WHERE domain = $1 FOR UPDATE`,
      [brandDomain]
    );
    const existing = existingResult.rows[0] ?? null;
    wasUpdate = !!existing;

    // Ownership boundary: don't let one org overwrite another's brand. Callers
    // can convert this into a brand-ownership escalation rather than a hard 403.
    if (existing && existing.workos_organization_id && existing.workos_organization_id !== workosOrganizationId) {
      throw new BrandIdentityError(
        403,
        'This brand domain is managed by another organization.',
        'cross_org_ownership',
        { brandDomain, currentOwnerOrgId: existing.workos_organization_id },
      );
    }

    if (existing) {
      // Orphan-adoption decision: if a prior owner relinquished, the new
      // claimant either adopts the existing manifest as a starting point
      // (acquisition / handoff case) or starts fresh (avoids inheriting
      // unrelated visual identity). Default = start fresh because most
      // claims are not handoffs.
      const claimingOrphaned = !!existing.manifest_orphaned;
      const startingManifest = claimingOrphaned && !adoptPriorManifest
        ? {}
        : (existing.brand_json ?? {});
      adoptedOrphanedManifest = claimingOrphaned;

      const bj = applyToBrandJson(startingManifest, displayName, logoUrl, brandColor);
      await client.query(
        `UPDATE brands SET
           brand_manifest = $1,
           workos_organization_id = COALESCE(workos_organization_id, $3),
           has_brand_manifest = TRUE,
           is_public = TRUE,
           manifest_orphaned = FALSE,
           prior_owner_org_id = NULL,
           updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(bj), existing.id, workosOrganizationId]
      );
    } else {
      const bj = applyToBrandJson({
        house: { domain: brandDomain, name: displayName },
      }, displayName, logoUrl, brandColor);
      await client.query(
        `INSERT INTO brands (workos_organization_id, domain, brand_manifest, brand_name, source_type, review_status, is_public, has_brand_manifest)
         VALUES ($1, $2, $3, COALESCE($3::jsonb->>'name', $2), 'community', 'approved', $4, true)
         ON CONFLICT (domain) DO UPDATE SET
           brand_manifest = COALESCE(EXCLUDED.brand_manifest, brands.brand_manifest),
           workos_organization_id = COALESCE(EXCLUDED.workos_organization_id, brands.workos_organization_id),
           is_public = COALESCE(EXCLUDED.is_public, brands.is_public),
           has_brand_manifest = true,
           updated_at = NOW()`,
        [workosOrganizationId, brandDomain, JSON.stringify(bj), true]
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

  logger.info({ profileId: profile?.id, brandDomain, wasUpdate, adoptedOrphanedManifest, hasLogo: !!logoUrl, hasColor: !!brandColor }, 'Brand identity updated');
  return { brandDomain, wasUpdate, adoptedOrphanedManifest };
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

