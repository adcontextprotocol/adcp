import { query } from './client.js';
import { createLogger } from '../logger.js';
import type { UpdateUserLocationInput, UserLocation } from '../types.js';

const logger = createLogger('users-db');

/**
 * User record from the users table
 */
export interface User {
  workos_user_id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  email_verified: boolean;
  engagement_score: number;
  excitement_score: number;
  lifecycle_stage: string;
  city?: string;
  country?: string;
  location_source?: string;
  location_updated_at?: Date;
  timezone?: string;
  primary_slack_user_id?: string;
  primary_organization_id?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Database operations for users
 */
export class UsersDatabase {
  /**
   * Get a user by their WorkOS user ID
   */
  async getUser(workosUserId: string): Promise<User | null> {
    const result = await query<User>(
      `SELECT * FROM users WHERE workos_user_id = $1`,
      [workosUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get user location
   */
  async getUserLocation(workosUserId: string): Promise<UserLocation | null> {
    const result = await query<UserLocation>(
      `SELECT city, country, location_source, location_updated_at
       FROM users WHERE workos_user_id = $1`,
      [workosUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update user location
   */
  async updateUserLocation(input: UpdateUserLocationInput): Promise<User | null> {
    const result = await query<User>(
      `UPDATE users
       SET city = COALESCE($2, city),
           country = COALESCE($3, country),
           location_source = $4,
           location_updated_at = NOW(),
           updated_at = NOW()
       WHERE workos_user_id = $1
       RETURNING *`,
      [input.workos_user_id, input.city || null, input.country || null, input.location_source]
    );
    return result.rows[0] || null;
  }

  /**
   * Find users by city
   */
  async findUsersByCity(city: string): Promise<User[]> {
    const result = await query<User>(
      `SELECT u.* FROM users u
       LEFT JOIN (
         SELECT workos_user_id, SUM(points) AS total_points
         FROM community_points GROUP BY workos_user_id
       ) cp ON cp.workos_user_id = u.workos_user_id
       WHERE LOWER(u.city) = LOWER($1)
       ORDER BY COALESCE(cp.total_points, 0) DESC`,
      [city]
    );
    return result.rows;
  }

  /**
   * Find users by country
   */
  async findUsersByCountry(country: string): Promise<User[]> {
    const result = await query<User>(
      `SELECT u.* FROM users u
       LEFT JOIN (
         SELECT workos_user_id, SUM(points) AS total_points
         FROM community_points GROUP BY workos_user_id
       ) cp ON cp.workos_user_id = u.workos_user_id
       WHERE LOWER(u.country) = LOWER($1)
       ORDER BY COALESCE(cp.total_points, 0) DESC`,
      [country]
    );
    return result.rows;
  }

  /**
   * Find users without location set
   */
  async findUsersWithoutLocation(limit = 100): Promise<User[]> {
    const result = await query<User>(
      `SELECT u.* FROM users u
       LEFT JOIN (
         SELECT workos_user_id, SUM(points) AS total_points
         FROM community_points GROUP BY workos_user_id
       ) cp ON cp.workos_user_id = u.workos_user_id
       WHERE u.city IS NULL AND u.country IS NULL
       ORDER BY COALESCE(cp.total_points, 0) DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Get location statistics
   */
  async getLocationStats(): Promise<{ city: string; country: string; count: number }[]> {
    const result = await query<{ city: string; country: string; count: number }>(
      `SELECT city, country, COUNT(*) as count
       FROM users
       WHERE city IS NOT NULL OR country IS NOT NULL
       GROUP BY city, country
       ORDER BY count DESC`
    );
    return result.rows;
  }

  /**
   * Get user's timezone
   */
  async getUserTimezone(workosUserId: string): Promise<string | null> {
    const result = await query<{ timezone: string }>(
      `SELECT timezone FROM users WHERE workos_user_id = $1`,
      [workosUserId]
    );
    return result.rows[0]?.timezone || null;
  }

  /**
   * Update user's timezone
   */
  async updateUserTimezone(workosUserId: string, timezone: string): Promise<User | null> {
    const result = await query<User>(
      `UPDATE users
       SET timezone = $2,
           updated_at = NOW()
       WHERE workos_user_id = $1
       RETURNING *`,
      [workosUserId, timezone]
    );
    return result.rows[0] || null;
  }

  /**
   * Find users by timezone
   */
  async findUsersByTimezone(timezone: string): Promise<User[]> {
    const result = await query<User>(
      `SELECT u.* FROM users u
       LEFT JOIN (
         SELECT workos_user_id, SUM(points) AS total_points
         FROM community_points GROUP BY workos_user_id
       ) cp ON cp.workos_user_id = u.workos_user_id
       WHERE u.timezone = $1
       ORDER BY COALESCE(cp.total_points, 0) DESC`,
      [timezone]
    );
    return result.rows;
  }

  /**
   * Get users without timezone set (useful for prompting them to set it)
   */
  async findUsersWithoutTimezone(limit = 100): Promise<User[]> {
    const result = await query<User>(
      `SELECT u.* FROM users u
       LEFT JOIN (
         SELECT workos_user_id, SUM(points) AS total_points
         FROM community_points GROUP BY workos_user_id
       ) cp ON cp.workos_user_id = u.workos_user_id
       WHERE u.timezone IS NULL
       ORDER BY COALESCE(cp.total_points, 0) DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

/**
 * Resolve the preferred organization for a user from their memberships.
 * Returns null if the user has no memberships.
 *
 * Tie-breaker: paying orgs first (subscription_status = 'active'), then most
 * recent membership. Note this matches on the column literal — a sub that's
 * still 'active' but has subscription_canceled_at set ranks the same as a
 * fully-paying one. That's looser than the org-filters MEMBER_FILTER but
 * good enough for the "which org is this user's primary?" question.
 *
 * For a user with memberships in multiple paying orgs, the most-recent wins.
 * Cross-org auth code that relies on a deterministic "primary" should
 * tolerate the user changing primary across membership additions.
 */
export async function resolvePreferredOrganization(workosUserId: string): Promise<string | null> {
  const result = await query<{ workos_organization_id: string }>(
    `SELECT om.workos_organization_id
     FROM organization_memberships om
     JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
     WHERE om.workos_user_id = $1
     ORDER BY
       CASE WHEN o.subscription_status = 'active' THEN 0 ELSE 1 END,
       om.created_at DESC
     LIMIT 1`,
    [workosUserId]
  );
  return result.rows[0]?.workos_organization_id ?? null;
}

/**
 * Backfill primary_organization_id for a user if not already set.
 * No-op if primary_organization_id is already set (idempotent).
 */
export async function backfillPrimaryOrganization(workosUserId: string, orgId: string): Promise<void> {
  await query(
    `UPDATE users SET primary_organization_id = $1, updated_at = NOW()
     WHERE workos_user_id = $2 AND primary_organization_id IS NULL`,
    [orgId, workosUserId]
  );
}

/**
 * Unconditionally point users.primary_organization_id at orgId. Used by the
 * resolver self-heal path when the cached column is set but dangles (org row
 * missing, or membership row missing). The webhook backfill keeps its
 * IS-NULL guard so a stray membership webhook can't repoint a user away
 * from the org they actually use.
 */
async function repointPrimaryOrganization(workosUserId: string, orgId: string): Promise<void> {
  await query(
    `UPDATE users SET primary_organization_id = $1, updated_at = NOW()
     WHERE workos_user_id = $2 AND primary_organization_id IS DISTINCT FROM $1`,
    [orgId, workosUserId]
  );
}

/**
 * Clear a stale primary_organization_id when no replacement membership
 * exists. Lets a future organization_membership.created webhook re-trigger
 * the IS-NULL backfill rather than leaving a phantom pointer in place.
 */
async function clearStalePrimaryOrganization(workosUserId: string, staleOrgId: string): Promise<void> {
  await query(
    `UPDATE users SET primary_organization_id = NULL, updated_at = NOW()
     WHERE workos_user_id = $1 AND primary_organization_id = $2`,
    [workosUserId, staleOrgId]
  );
}

/**
 * Resolve the user's primary organization id.
 *
 *   1. Read users.primary_organization_id, but only trust it when both the
 *      organization row and a current membership row still exist. A bare
 *      column read masquerades a deleted/never-synced org as a valid cache
 *      hit and 404s every tier-gated read site (#…).
 *   2. On miss/dangle, derive from organization_memberships (preferring
 *      paying orgs) and repoint the cache.
 *   3. If no derived org exists either, clear the stale pointer so a later
 *      membership webhook can re-trigger the IS-NULL backfill.
 *
 * Returns null when the user has no valid organization affiliation.
 *
 * Use this instead of selecting primary_organization_id directly. Direct
 * reads silently return null (or worse, a phantom orgId) for users whose
 * cache state drifted from organizations / organization_memberships, which
 * silently breaks every surface that gates on the column. The integrity
 * invariant `users-have-primary-organization` catches both drift modes.
 */
export async function resolvePrimaryOrganization(workosUserId: string): Promise<string | null> {
  // Single read returns both the cached pointer AND whether the joins to
  // organizations + organization_memberships still hold. Lets us trust the
  // cache only when both are present, while still knowing what value was
  // stored so the no-recourse branch can clear a dangling id without an
  // extra round trip.
  const cached = await query<{ primary_organization_id: string | null; joins_valid: boolean }>(
    `SELECT u.primary_organization_id,
            (
              EXISTS (
                SELECT 1 FROM organizations o
                 WHERE o.workos_organization_id = u.primary_organization_id
              )
              AND EXISTS (
                SELECT 1 FROM organization_memberships om
                 WHERE om.workos_user_id = u.workos_user_id
                   AND om.workos_organization_id = u.primary_organization_id
              )
            ) AS joins_valid
       FROM users u
      WHERE u.workos_user_id = $1`,
    [workosUserId]
  );
  const row = cached.rows[0];
  if (row?.primary_organization_id && row.joins_valid) {
    return row.primary_organization_id;
  }

  const derived = await resolvePreferredOrganization(workosUserId);
  if (!derived) {
    // Cache was set to a dangling id and no replacement exists — null it
    // out so a later membership webhook can re-trigger the IS-NULL backfill.
    if (row?.primary_organization_id) {
      const staleOrgId = row.primary_organization_id;
      clearStalePrimaryOrganization(workosUserId, staleOrgId).catch((err) => {
        logger.warn({ err, userId: workosUserId, staleOrgId }, 'failed to clear stale primary_organization_id');
      });
    }
    return null;
  }

  // Cache didn't pass the JOIN check but a derived org exists — repoint
  // unconditionally. The IS-NULL-guarded backfill helper would let a
  // dangling pointer persist forever.
  repointPrimaryOrganization(workosUserId, derived).catch((err) => {
    logger.warn({ err, userId: workosUserId, orgId: derived }, 'opportunistic primary_organization_id repoint failed');
  });

  return derived;
}
