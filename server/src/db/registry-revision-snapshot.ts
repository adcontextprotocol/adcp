/**
 * Field allowlists for registry revision snapshots.
 *
 * A revision snapshot is a copy of a whole registry row, and registry rows
 * carry ownership, contact and verification columns that an edit history has
 * no reason to reproduce. The writers snapshot `SELECT *` results, so a
 * column added to `brands` or `hosted_properties` later would be copied into
 * every new snapshot without anyone revisiting this file. That is why the
 * snapshot shape is an allowlist rather than a list of fields to remove: a
 * column that is not named here never reaches a stored snapshot, a review
 * prompt, or an API response.
 *
 * Both seams apply these: every write into `*_revisions.snapshot`, and every
 * read back out. The read-side pass is what keeps rows written before the
 * allowlist existed from being served as they were stored.
 *
 * Adding a field here makes it readable by everything that can read a
 * revision, including unauthenticated callers of the public history views.
 * Content and published state belong here; ownership, contact and
 * verification columns do not.
 */

/**
 * `hosted_properties` columns a property revision snapshot may carry.
 *
 * Deliberately absent: `workos_organization_id`, `claimant_org_id`,
 * `created_by_user_id`, `created_by_email`, `verification_token`,
 * `claim_token`, and the row's own `id`.
 */
export const PROPERTY_REVISION_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set([
  'publisher_domain',
  'adagents_json',
  'source_type',
  'is_public',
  'review_status',
  'domain_verified',
  'origin_verified_at',
  'origin_last_checked_at',
  'created_at',
  'updated_at',
]);

/**
 * `brands` columns a brand revision snapshot may carry.
 *
 * Deliberately absent: `workos_organization_id`, `prior_owner_org_id`,
 * `created_by_user_id`, `created_by_email`, `verification_token`, and the
 * row's own `id`.
 */
export const BRAND_REVISION_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set([
  'domain',
  'brand_id',
  'canonical_domain',
  'house_domain',
  'claimed_house_domain',
  'brand_name',
  'brand_names',
  'keller_type',
  'parent_brand',
  'brand_agent_url',
  'brand_agent_capabilities',
  'has_brand_manifest',
  'brand_manifest',
  'source_type',
  'enrichment_provider',
  'review_status',
  'is_public',
  'domain_verified',
  'manifest_orphaned',
  'relationship_trust',
  'relationship_verified_at',
  'relationship_trust_computed_at',
  'discovered_at',
  'last_validated',
  'expires_at',
  'created_at',
  'updated_at',
]);

/**
 * Keep only the allowlisted keys. Returns the input unchanged when it is not
 * a plain object (a JSONB column can hold anything) and when nothing was
 * dropped, so callers can keep comparing by identity.
 */
export function pickSnapshotFields<T extends Record<string, unknown>>(
  snapshot: T,
  allowed: ReadonlySet<string>,
): T {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;

  let dropped = false;
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(snapshot)) {
    if (allowed.has(key)) {
      picked[key] = snapshot[key];
    } else {
      dropped = true;
    }
  }
  return dropped ? (picked as T) : snapshot;
}

/**
 * Reduce a `hosted_properties` row to the fields a revision may carry.
 * Mirrors `sanitizeBrandSnapshot` in `brand-db.ts`, which layers the brand
 * manifest's own rules on top of {@link BRAND_REVISION_SNAPSHOT_FIELDS}.
 */
export function sanitizePropertySnapshot<T extends Record<string, unknown>>(snapshot: T): T {
  return pickSnapshotFields(snapshot, PROPERTY_REVISION_SNAPSHOT_FIELDS);
}
