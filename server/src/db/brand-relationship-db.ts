import { query } from './client.js';

export interface BrandRelationshipDeclaration {
  houseDomain: string;
  leafDomain: string;
  brandId: string;
  effectiveAt?: string;
}

/**
 * Atomically records a publisher declaration or returns the shared first
 * observation when effective_at is absent. An explicit timestamp replaces a
 * prior value; later omission cannot erase or renew the stored clock.
 */
export async function observeBrandRelationshipDeclaration(
  declaration: BrandRelationshipDeclaration,
): Promise<number> {
  const result = await query<{ declared_at: Date | string }>(
    `INSERT INTO brand_relationship_declarations (
       house_domain, leaf_domain, brand_id, declared_at
     ) VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
     ON CONFLICT (house_domain, leaf_domain, brand_id) DO UPDATE SET
       declared_at = CASE
         WHEN $4::timestamptz IS NULL
           THEN brand_relationship_declarations.declared_at
         ELSE EXCLUDED.declared_at
       END,
       last_observed_at = NOW()
     RETURNING declared_at`,
    [
      declaration.houseDomain.toLowerCase(),
      declaration.leafDomain.toLowerCase(),
      declaration.brandId,
      declaration.effectiveAt ?? null,
    ],
  );
  const declaredAt = new Date(result.rows[0].declared_at).getTime();
  if (Number.isNaN(declaredAt)) {
    throw new Error('Stored brand relationship declaration has an invalid timestamp');
  }
  return declaredAt;
}
