import { query, getPool } from './client.js';
import type {
  MemberProfile,
  CreateMemberProfileInput,
  UpdateMemberProfileInput,
  ListMemberProfilesOptions,
  MemberOffering,
  AgentConfig,
  PublisherConfig,
} from '../types.js';

/**
 * Escape LIKE pattern wildcards to prevent SQL injection
 */
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Database operations for member profiles
 */
export class MemberDatabase {
  /**
   * Create a new member profile
   */
  async createProfile(input: CreateMemberProfileInput): Promise<MemberProfile> {
    const agents = input.agents || [];
    const publishers = input.publishers || [];

    const result = await query<MemberProfile>(
      `INSERT INTO member_profiles (
        workos_organization_id, display_name, slug, tagline, description,
        logo_url, logo_light_url, logo_dark_url, brand_color,
        contact_email, contact_website, contact_phone,
        linkedin_url, twitter_url,
        offerings, agents, publishers, headquarters, markets, metadata, tags,
        is_public, show_in_carousel
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *`,
      [
        input.workos_organization_id,
        input.display_name,
        input.slug,
        input.tagline || null,
        input.description || null,
        input.logo_url || null,
        input.logo_light_url || null,
        input.logo_dark_url || null,
        input.brand_color || null,
        input.contact_email || null,
        input.contact_website || null,
        input.contact_phone || null,
        input.linkedin_url || null,
        input.twitter_url || null,
        input.offerings || [],
        JSON.stringify(agents),
        JSON.stringify(publishers),
        input.headquarters || null,
        input.markets || [],
        JSON.stringify(input.metadata || {}),
        input.tags || [],
        input.is_public ?? false,
        input.show_in_carousel ?? false,
      ]
    );

    return this.deserializeProfile(result.rows[0]);
  }

  /**
   * Get profile by ID
   */
  async getProfileById(id: string): Promise<MemberProfile | null> {
    const result = await query<MemberProfile>(
      'SELECT * FROM member_profiles WHERE id = $1',
      [id]
    );

    return result.rows[0] ? this.deserializeProfile(result.rows[0]) : null;
  }

  /**
   * Get profile by slug
   */
  async getProfileBySlug(slug: string): Promise<MemberProfile | null> {
    const result = await query<MemberProfile>(
      'SELECT * FROM member_profiles WHERE slug = $1',
      [slug]
    );

    return result.rows[0] ? this.deserializeProfile(result.rows[0]) : null;
  }

  /**
   * Get profile by organization ID
   */
  async getProfileByOrgId(workos_organization_id: string): Promise<MemberProfile | null> {
    const result = await query<MemberProfile>(
      'SELECT * FROM member_profiles WHERE workos_organization_id = $1',
      [workos_organization_id]
    );

    return result.rows[0] ? this.deserializeProfile(result.rows[0]) : null;
  }

  /**
   * Update member profile
   */
  async updateProfile(
    id: string,
    updates: UpdateMemberProfileInput
  ): Promise<MemberProfile | null> {
    // Build SET clause dynamically using explicit column mapping
    const COLUMN_MAP: Record<keyof UpdateMemberProfileInput, string> = {
      display_name: 'display_name',
      tagline: 'tagline',
      description: 'description',
      logo_url: 'logo_url',
      logo_light_url: 'logo_light_url',
      logo_dark_url: 'logo_dark_url',
      brand_color: 'brand_color',
      contact_email: 'contact_email',
      contact_website: 'contact_website',
      contact_phone: 'contact_phone',
      linkedin_url: 'linkedin_url',
      twitter_url: 'twitter_url',
      offerings: 'offerings',
      agents: 'agents',
      publishers: 'publishers',
      headquarters: 'headquarters',
      markets: 'markets',
      metadata: 'metadata',
      tags: 'tags',
      is_public: 'is_public',
      show_in_carousel: 'show_in_carousel',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const columnName = COLUMN_MAP[key as keyof UpdateMemberProfileInput];
      if (!columnName) {
        continue; // Skip unknown fields
      }

      setClauses.push(`${columnName} = $${paramIndex++}`);
      if (key === 'metadata' || key === 'agents' || key === 'publishers') {
        params.push(JSON.stringify(value));
      } else {
        params.push(value);
      }
    }

    if (setClauses.length === 0) {
      return this.getProfileById(id);
    }

    params.push(id);
    const sql = `
      UPDATE member_profiles
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await query<MemberProfile>(sql, params);
    return result.rows[0] ? this.deserializeProfile(result.rows[0]) : null;
  }

  /**
   * Update profile by organization ID (for authenticated users updating their own profile)
   */
  async updateProfileByOrgId(
    workos_organization_id: string,
    updates: UpdateMemberProfileInput
  ): Promise<MemberProfile | null> {
    const profile = await this.getProfileByOrgId(workos_organization_id);
    if (!profile) {
      return null;
    }
    return this.updateProfile(profile.id, updates);
  }

  /**
   * Delete member profile
   */
  async deleteProfile(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM member_profiles WHERE id = $1',
      [id]
    );

    return (result.rowCount || 0) > 0;
  }

  /**
   * List member profiles with filtering and search
   */
  async listProfiles(options: ListMemberProfilesOptions = {}): Promise<MemberProfile[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Filter by public visibility
    if (options.is_public !== undefined) {
      conditions.push(`is_public = $${paramIndex++}`);
      params.push(options.is_public);
    }

    // Filter by carousel visibility
    if (options.show_in_carousel !== undefined) {
      conditions.push(`show_in_carousel = $${paramIndex++}`);
      params.push(options.show_in_carousel);
    }

    // Filter by featured
    if (options.featured !== undefined) {
      conditions.push(`featured = $${paramIndex++}`);
      params.push(options.featured);
    }

    // Filter by offerings (array overlap)
    if (options.offerings && options.offerings.length > 0) {
      conditions.push(`offerings && $${paramIndex++}::text[]`);
      params.push(options.offerings);
    }

    // Filter by markets (array overlap)
    if (options.markets && options.markets.length > 0) {
      conditions.push(`markets && $${paramIndex++}::text[]`);
      params.push(options.markets);
    }

    // Full-text search
    if (options.search) {
      conditions.push(`(
        display_name ILIKE $${paramIndex} OR
        tagline ILIKE $${paramIndex} OR
        description ILIKE $${paramIndex} OR
        headquarters ILIKE $${paramIndex} OR
        tags::text ILIKE $${paramIndex}
      )`);
      params.push(`%${escapeLikePattern(options.search)}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Build query with ordering (featured first, then by name)
    let sql = `
      SELECT * FROM member_profiles
      ${whereClause}
      ORDER BY featured DESC, display_name ASC
    `;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<MemberProfile>(sql, params);
    return result.rows.map(row => this.deserializeProfile(row));
  }

  /**
   * Get profiles for homepage carousel (public + show_in_carousel)
   */
  async getCarouselProfiles(): Promise<MemberProfile[]> {
    return this.listProfiles({
      is_public: true,
      show_in_carousel: true,
    });
  }

  /**
   * Get public profiles for directory
   */
  async getPublicProfiles(options: {
    search?: string;
    offerings?: MemberOffering[];
    markets?: string[];
    limit?: number;
    offset?: number;
  } = {}): Promise<MemberProfile[]> {
    return this.listProfiles({
      is_public: true,
      ...options,
    });
  }

  /**
   * Check if slug is available
   */
  async isSlugAvailable(slug: string, excludeId?: string): Promise<boolean> {
    let sql = 'SELECT 1 FROM member_profiles WHERE slug = $1';
    const params: unknown[] = [slug];

    if (excludeId) {
      sql += ' AND id != $2';
      params.push(excludeId);
    }

    sql += ' LIMIT 1';

    const result = await query(sql, params);
    return result.rows.length === 0;
  }

  /**
   * Deserialize database row (parse JSONB fields)
   */
  private deserializeProfile(row: any): MemberProfile {
    // Parse agents JSONB
    let agents: AgentConfig[] = [];
    if (row.agents) {
      agents = typeof row.agents === 'string'
        ? JSON.parse(row.agents)
        : row.agents;
    }

    // Parse publishers JSONB
    let publishers: PublisherConfig[] = [];
    if (row.publishers) {
      publishers = typeof row.publishers === 'string'
        ? JSON.parse(row.publishers)
        : row.publishers;
    }

    return {
      ...row,
      agents,
      publishers,
      markets: row.markets || [],
      metadata: typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : row.metadata || {},
    };
  }

}
