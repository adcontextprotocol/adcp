import { query } from './client.js';
import type { UpdateUserLocationInput, UserLocation } from '../types.js';

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
      `SELECT * FROM users
       WHERE LOWER(city) = LOWER($1)
       ORDER BY engagement_score DESC`,
      [city]
    );
    return result.rows;
  }

  /**
   * Find users by country
   */
  async findUsersByCountry(country: string): Promise<User[]> {
    const result = await query<User>(
      `SELECT * FROM users
       WHERE LOWER(country) = LOWER($1)
       ORDER BY engagement_score DESC`,
      [country]
    );
    return result.rows;
  }

  /**
   * Find users without location set
   */
  async findUsersWithoutLocation(limit = 100): Promise<User[]> {
    const result = await query<User>(
      `SELECT * FROM users
       WHERE city IS NULL AND country IS NULL
       ORDER BY engagement_score DESC
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
}
