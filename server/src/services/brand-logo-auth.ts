/**
 * Brand logo authorization — determines who can review logos for a given domain.
 *
 * Two paths:
 * 1. Registry moderators (brand-registry-moderators working group) — can review any brand
 * 2. Verified brand owners (brands with domain_verified) — can review their own brand
 */

import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { BrandDatabase } from '../db/brand-db.js';
import { query } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-logo-auth');

const MODERATOR_GROUP_SLUG = 'brand-registry-moderators';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SHORT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for negative results

const moderatorCache = new Map<string, { isModerator: boolean; expiresAt: number }>();

const wgDb = new WorkingGroupDatabase();

async function isRegistryModerator(userId: string): Promise<boolean> {
  const cached = moderatorCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isModerator;
  }

  try {
    const group = await wgDb.getWorkingGroupBySlug(MODERATOR_GROUP_SLUG);
    if (!group) {
      moderatorCache.set(userId, { isModerator: false, expiresAt: Date.now() + SHORT_CACHE_TTL_MS });
      return false;
    }

    const isModerator = await wgDb.isMember(group.id, userId);
    moderatorCache.set(userId, { isModerator, expiresAt: Date.now() + CACHE_TTL_MS });
    return isModerator;
  } catch (err) {
    logger.error({ err, userId }, 'Error checking registry moderator status');
    return false;
  }
}

async function isVerifiedBrandOwner(userId: string, domain: string, brandDb: BrandDatabase): Promise<boolean> {
  try {
    const hosted = await brandDb.getHostedBrandByDomain(domain);
    if (!hosted || !hosted.domain_verified) return false;

    // Check if user belongs to the org that owns this brand
    if (!hosted.workos_organization_id) return false;

    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM organization_memberships
        WHERE workos_user_id = $1 AND workos_organization_id = $2
      ) AS exists`,
      [userId, hosted.workos_organization_id]
    );
    return result.rows[0]?.exists ?? false;
  } catch (err) {
    logger.error({ err, userId, domain }, 'Error checking brand ownership');
    return false;
  }
}

/**
 * Check if a user can review brand logos for the given domain.
 * Returns true if the user is a registry moderator or verified brand owner.
 */
export async function canReviewBrandLogos(
  userId: string,
  domain: string,
  brandDb: BrandDatabase,
): Promise<boolean> {
  // Check moderator first (cheaper, cached)
  if (await isRegistryModerator(userId)) return true;
  // Then check brand ownership
  return isVerifiedBrandOwner(userId, domain, brandDb);
}

export function invalidateModeratorCache(userId?: string): void {
  if (userId) {
    moderatorCache.delete(userId);
  } else {
    moderatorCache.clear();
  }
}
