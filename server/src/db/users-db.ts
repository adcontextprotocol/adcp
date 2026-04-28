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
 * Prefers paying orgs, then most recently created membership.
 * Returns null if the user has no memberships.
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
 * Resolve the user's primary organization id.
 *
 *   1. Read users.primary_organization_id (the cached pointer).
 *   2. If NULL, derive from organization_memberships (preferring paying orgs).
 *   3. Best-effort backfill so the next read hits the fast path.
 *
 * Returns null when the user has no organization at all.
 *
 * Use this instead of selecting primary_organization_id directly. Direct reads
 * silently return null for users whose backfill never completed (race between
 * organization_membership.created and user.created webhooks, fire-and-forget
 * backfill failures), which silently breaks every surface that gates on the
 * column. The integrity invariant `users-have-primary-organization` catches
 * any rows that stay NULL despite the fallback.
 */
export async function resolvePrimaryOrganization(workosUserId: string): Promise<string | null> {
  const cached = await query<{ primary_organization_id: string | null }>(
    `SELECT primary_organization_id FROM users
       WHERE workos_user_id = $1 AND primary_organization_id IS NOT NULL`,
    [workosUserId]
  );
  if (cached.rows[0]?.primary_organization_id) {
    return cached.rows[0].primary_organization_id;
  }

  const derived = await resolvePreferredOrganization(workosUserId);
  if (!derived) return null;

  // Opportunistic backfill — failures don't block the lookup. The integrity
  // invariant catches any row that stays NULL (e.g. because the users row
  // doesn't exist yet, or a transient DB error swallows the UPDATE).
  backfillPrimaryOrganization(workosUserId, derived).catch((err) => {
    logger.warn({ err, userId: workosUserId, orgId: derived }, 'opportunistic primary_organization_id backfill failed');
  });

  return derived;
}
