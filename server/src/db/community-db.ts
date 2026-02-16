import { query } from './client.js';

function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

export interface CommunityProfile {
  workos_user_id: string;
  slug: string | null;
  headline: string | null;
  bio: string | null;
  avatar_url: string | null;
  expertise: string[];
  interests: string[];
  linkedin_url: string | null;
  twitter_url: string | null;
  github_username: string | null;
  is_public: boolean;
  open_to_coffee_chat: boolean;
  open_to_intros: boolean;
  city?: string | null;
}

export interface UpdateCommunityProfileInput {
  slug?: string;
  headline?: string;
  bio?: string;
  avatar_url?: string;
  expertise?: string[];
  interests?: string[];
  linkedin_url?: string;
  twitter_url?: string;
  github_username?: string;
  is_public?: boolean;
  open_to_coffee_chat?: boolean;
  open_to_intros?: boolean;
  city?: string;
}

export interface PersonListItem {
  workos_user_id: string;
  slug: string;
  first_name: string;
  last_name: string;
  headline: string | null;
  bio: string | null;
  avatar_url: string | null;
  expertise: string[];
  city: string | null;
  country: string | null;
  open_to_coffee_chat: boolean;
  open_to_intros: boolean;
  organization_name: string | null;
  connection_status?: string | null;
}

export interface PersonPerspective {
  id: string;
  slug: string;
  title: string;
  content_type: 'article' | 'link';
  category: string | null;
  excerpt: string | null;
  external_url: string | null;
  external_site_name: string | null;
  published_at: string;
}

export interface RegistryContribution {
  contribution_type: 'brand_edit' | 'property_edit' | 'brand_create' | 'property_create';
  domain: string;
  summary: string;
  created_at: string;
  revision_number: number | null;
}

export interface PersonDetail extends PersonListItem {
  interests: string[];
  linkedin_url: string | null;
  twitter_url: string | null;
  github_username: string | null;
  total_points: number;
  tier: string;
  badges: Badge[];
  working_groups: { id: string; name: string; slug: string }[];
  events: { id: string; title: string; start_time: string }[];
  perspectives: PersonPerspective[];
  registry_contributions: RegistryContribution[];
  profile_completeness: number;
  connection_status: string | null;
  connection_id: string | null;
  connection_direction: 'sent' | 'received' | null;
}

export interface Connection {
  id: string;
  requester_user_id: string;
  recipient_user_id: string;
  status: string;
  message: string | null;
  created_at: string;
  responded_at: string | null;
  other_user?: PersonListItem;
}

export interface Badge {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string;
  awarded_at?: string;
}

export interface PointEntry {
  action: string;
  points: number;
  reference_id: string | null;
  reference_type: string | null;
  created_at: string;
}

export interface ListPeopleOptions {
  search?: string;
  expertise?: string;
  city?: string;
  open_to_coffee_chat?: boolean;
  limit?: number;
  offset?: number;
  viewer_user_id?: string;
}

export interface HubData {
  profile: CommunityProfile & { first_name: string; last_name: string; city: string | null; country: string | null };
  profile_completeness: number;
  total_points: number;
  tier: string;
  badges: Badge[];
  suggested_connections: PersonListItem[];
  recent_profiles: PersonListItem[];
  upcoming_events: { id: string; title: string; start_time: string; co_attendee_count: number }[];
  working_groups: { id: string; name: string; slug: string; member_count: number }[];
  connection_count: number;
  pending_request_count: number;
}

export class CommunityDatabase {

  // =====================================================
  // PROFILE OPERATIONS
  // =====================================================

  async updateProfile(userId: string, updates: UpdateCommunityProfileInput): Promise<CommunityProfile | null> {
    const COLUMN_MAP: Record<keyof UpdateCommunityProfileInput, string> = {
      slug: 'slug',
      headline: 'headline',
      bio: 'bio',
      avatar_url: 'avatar_url',
      expertise: 'expertise',
      interests: 'interests',
      linkedin_url: 'linkedin_url',
      twitter_url: 'twitter_url',
      github_username: 'github_username',
      is_public: 'is_public',
      open_to_coffee_chat: 'open_to_coffee_chat',
      open_to_intros: 'open_to_intros',
      city: 'city',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Normalize tag arrays: lowercase, trim, deduplicate
    if (updates.expertise) {
      updates.expertise = [...new Set(updates.expertise.map(t => t.trim().toLowerCase()).filter(Boolean))];
    }
    if (updates.interests) {
      updates.interests = [...new Set(updates.interests.map(t => t.trim().toLowerCase()).filter(Boolean))];
    }

    for (const [key, value] of Object.entries(updates)) {
      const columnName = COLUMN_MAP[key as keyof UpdateCommunityProfileInput];
      if (!columnName) continue;
      setClauses.push(`${columnName} = $${paramIndex++}`);
      params.push(value);
    }

    if (setClauses.length === 0) {
      return this.getProfile(userId);
    }

    params.push(userId);
    const sql = `
      UPDATE users
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE workos_user_id = $${paramIndex}
      RETURNING workos_user_id, slug, headline, bio, avatar_url, expertise, interests,
                linkedin_url, twitter_url, github_username, is_public, open_to_coffee_chat, open_to_intros, city
    `;

    const result = await query<CommunityProfile>(sql, params);
    return result.rows[0] || null;
  }

  async getProfile(userId: string): Promise<CommunityProfile | null> {
    const result = await query<CommunityProfile>(
      `SELECT workos_user_id, slug, headline, bio, avatar_url, expertise, interests,
              linkedin_url, twitter_url, github_username, is_public, open_to_coffee_chat, open_to_intros,
              city
       FROM users WHERE workos_user_id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  }

  getProfileCompleteness(user: {
    headline?: string | null;
    bio?: string | null;
    avatar_url?: string | null;
    expertise?: string[] | null;
    interests?: string[] | null;
    city?: string | null;
    linkedin_url?: string | null;
    github_username?: string | null;
    open_to_coffee_chat?: boolean;
    open_to_intros?: boolean;
  }): number {
    let filled = 0;
    const total = 10;
    if (user.headline) filled++;
    if (user.bio) filled++;
    if (user.avatar_url) filled++;
    if (user.expertise && user.expertise.length > 0) filled++;
    if (user.interests && user.interests.length > 0) filled++;
    if (user.city) filled++;
    if (user.linkedin_url) filled++;
    if (user.github_username) filled++;
    if (user.open_to_coffee_chat) filled++;
    if (user.open_to_intros) filled++;
    return Math.round((filled / total) * 100);
  }

  // =====================================================
  // PEOPLE DIRECTORY
  // =====================================================

  async listPeople(options: ListPeopleOptions = {}): Promise<{ people: PersonListItem[]; total: number }> {
    const conditions: string[] = ['u.is_public = true', 'u.slug IS NOT NULL'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.search) {
      const pattern = `%${escapeLikePattern(options.search)}%`;
      conditions.push(`(
        u.first_name ILIKE $${paramIndex} OR
        u.last_name ILIKE $${paramIndex} OR
        u.headline ILIKE $${paramIndex} OR
        u.bio ILIKE $${paramIndex} OR
        (u.first_name || ' ' || u.last_name) ILIKE $${paramIndex}
      )`);
      params.push(pattern);
      paramIndex++;
    }

    if (options.expertise) {
      conditions.push(`u.expertise && $${paramIndex++}::text[]`);
      params.push([options.expertise]);
    }

    if (options.city) {
      conditions.push(`u.city ILIKE $${paramIndex++}`);
      params.push(`%${escapeLikePattern(options.city)}%`);
    }

    if (options.open_to_coffee_chat) {
      conditions.push('u.open_to_coffee_chat = true');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    // Snapshot filter params for the count query before adding viewer/pagination params
    const filterParams = params.slice();

    // Connection status subquery for logged-in viewer
    let connectionSelect = "NULL as connection_status";
    if (options.viewer_user_id) {
      connectionSelect = `(
        SELECT c.status FROM connections c
        WHERE (c.requester_user_id = $${paramIndex} AND c.recipient_user_id = u.workos_user_id)
           OR (c.requester_user_id = u.workos_user_id AND c.recipient_user_id = $${paramIndex})
        LIMIT 1
      ) as connection_status`;
      params.push(options.viewer_user_id);
      paramIndex++;
    }

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM users u ${whereClause}`,
      filterParams
    );

    params.push(limit, offset);
    const sql = `
      SELECT u.workos_user_id, u.slug, u.first_name, u.last_name, u.headline, u.bio,
             u.avatar_url, u.expertise, u.city, u.country,
             u.open_to_coffee_chat, u.open_to_intros,
             CASE WHEN o.is_personal THEN NULL ELSE o.name END as organization_name,
             ${connectionSelect},
             COALESCE(
               (SELECT json_agg(json_build_object('id', b.id, 'name', b.name, 'icon', b.icon))
                FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
                WHERE ub.workos_user_id = u.workos_user_id),
               '[]'::json
             ) as badges
      FROM users u
      LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
      ${whereClause}
      ORDER BY u.engagement_score DESC NULLS LAST, u.first_name ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const result = await query<PersonListItem & { badges: Badge[] }>(sql, params);

    return {
      people: result.rows,
      total: parseInt(countResult.rows[0]?.count || '0', 10),
    };
  }

  async getPersonBySlug(slug: string, viewerUserId?: string): Promise<PersonDetail | null> {
    // Base user data
    const userResult = await query<PersonListItem & { interests: string[]; linkedin_url: string | null; twitter_url: string | null; github_username: string | null }>(
      `SELECT u.workos_user_id, u.slug, u.first_name, u.last_name, u.headline, u.bio,
              u.avatar_url, u.expertise, u.interests, u.city, u.country,
              u.open_to_coffee_chat, u.open_to_intros, u.linkedin_url, u.twitter_url,
              u.github_username, CASE WHEN o.is_personal THEN NULL ELSE o.name END as organization_name
       FROM users u
       LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
       WHERE u.slug = $1
         AND (u.is_public = true OR u.workos_user_id = $2)`,
      [slug, viewerUserId || '']
    );

    const user = userResult.rows[0];
    if (!user) return null;

    // Fetch enrichments in parallel
    const [points, badges, workingGroups, events, perspectives, registryContributions, connectionStatus] = await Promise.all([
      this.getUserPoints(user.workos_user_id),
      this.getUserBadges(user.workos_user_id),
      this.getUserWorkingGroups(user.workos_user_id),
      this.getUserEvents(user.workos_user_id),
      this.getUserPublishedContent(user.workos_user_id),
      this.getUserRegistryContributions(user.workos_user_id),
      viewerUserId ? this.getConnectionStatus(viewerUserId, user.workos_user_id) : Promise.resolve(null),
    ]);

    return {
      ...user,
      total_points: points,
      tier: this.getTierName(points),
      badges,
      working_groups: workingGroups,
      events,
      perspectives,
      registry_contributions: registryContributions,
      profile_completeness: this.getProfileCompleteness(user),
      connection_status: connectionStatus?.status || null,
      connection_id: connectionStatus?.id || null,
      connection_direction: connectionStatus?.direction || null,
    };
  }

  private async getUserWorkingGroups(userId: string): Promise<{ id: string; name: string; slug: string }[]> {
    const result = await query<{ id: string; name: string; slug: string }>(
      `SELECT wg.id, wg.name, wg.slug
       FROM working_groups wg
       JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
       WHERE wgm.workos_user_id = $1 AND wgm.status = 'active'
       ORDER BY wg.name`,
      [userId]
    );
    return result.rows;
  }

  private async getUserEvents(userId: string): Promise<{ id: string; title: string; start_time: string }[]> {
    const result = await query<{ id: string; title: string; start_time: string }>(
      `SELECT e.id, e.title, e.start_time
       FROM events e
       JOIN event_registrations er ON er.event_id = e.id
       WHERE er.workos_user_id = $1
       ORDER BY e.start_time DESC
       LIMIT 10`,
      [userId]
    );
    return result.rows;
  }

  async getUserPublishedContent(userId: string): Promise<PersonPerspective[]> {
    const result = await query<PersonPerspective>(
      `SELECT DISTINCT p.id, p.slug, p.title, p.content_type, p.category,
              p.excerpt, p.external_url, p.external_site_name, p.published_at
       FROM perspectives p
       LEFT JOIN content_authors ca ON ca.perspective_id = p.id
       WHERE p.status = 'published'
         AND (p.author_user_id = $1 OR p.proposer_user_id = $1 OR ca.user_id = $1)
       ORDER BY p.published_at DESC
       LIMIT 20`,
      [userId]
    );
    return result.rows;
  }

  async getUserRegistryContributions(userId: string): Promise<RegistryContribution[]> {
    const result = await query<RegistryContribution>(
      `SELECT * FROM (
        SELECT 'brand_edit' as contribution_type, br.entity_domain as domain,
               br.edit_summary as summary, br.created_at, br.revision_number
        FROM brand_revisions br WHERE br.editor_user_id = $1
        UNION ALL
        SELECT 'property_edit' as contribution_type, pr.entity_domain as domain,
               pr.edit_summary as summary, pr.created_at, pr.revision_number
        FROM property_revisions pr WHERE pr.editor_user_id = $1
        UNION ALL
        SELECT 'brand_create' as contribution_type, hb.domain,
               'Created brand listing' as summary, hb.created_at, NULL as revision_number
        FROM hosted_brands hb WHERE hb.created_by_user_id = $1
        UNION ALL
        SELECT 'property_create' as contribution_type, hp.domain,
               'Created property listing' as summary, hp.created_at, NULL as revision_number
        FROM hosted_properties hp WHERE hp.created_by_user_id = $1
      ) contributions
      ORDER BY created_at DESC
      LIMIT 20`,
      [userId]
    );
    return result.rows;
  }

  // =====================================================
  // CONNECTIONS
  // =====================================================

  async requestConnection(requesterId: string, recipientId: string, message?: string): Promise<Connection> {
    const result = await query<Connection>(
      `INSERT INTO connections (requester_user_id, recipient_user_id, message)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [requesterId, recipientId, message || null]
    );
    return result.rows[0];
  }

  async respondToConnection(connectionId: string, userId: string, status: 'accepted' | 'declined'): Promise<Connection | null> {
    const result = await query<Connection>(
      `UPDATE connections
       SET status = $1, responded_at = NOW()
       WHERE id = $2 AND recipient_user_id = $3 AND status = 'pending'
       RETURNING *`,
      [status, connectionId, userId]
    );
    return result.rows[0] || null;
  }

  async listConnections(userId: string): Promise<Connection[]> {
    const result = await query<Connection & { other_first_name: string; other_last_name: string; other_slug: string; other_headline: string | null; other_avatar_url: string | null; other_city: string | null; other_org_name: string | null; other_expertise: string[] }>(
      `SELECT c.*,
              u.first_name as other_first_name, u.last_name as other_last_name,
              u.slug as other_slug, u.headline as other_headline,
              u.avatar_url as other_avatar_url, u.city as other_city,
              u.expertise as other_expertise,
              CASE WHEN o.is_personal THEN NULL ELSE o.name END as other_org_name
       FROM connections c
       JOIN users u ON u.workos_user_id = CASE
         WHEN c.requester_user_id = $1 THEN c.recipient_user_id
         ELSE c.requester_user_id
       END
       LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
       WHERE (c.requester_user_id = $1 OR c.recipient_user_id = $1)
         AND c.status = 'accepted'
       ORDER BY c.responded_at DESC`,
      [userId]
    );

    return result.rows.map(row => ({
      id: row.id,
      requester_user_id: row.requester_user_id,
      recipient_user_id: row.recipient_user_id,
      status: row.status,
      message: row.message,
      created_at: row.created_at,
      responded_at: row.responded_at,
      other_user: {
        workos_user_id: row.requester_user_id === userId ? row.recipient_user_id : row.requester_user_id,
        slug: row.other_slug,
        first_name: row.other_first_name,
        last_name: row.other_last_name,
        headline: row.other_headline,
        bio: null,
        avatar_url: row.other_avatar_url,
        expertise: row.other_expertise || [],
        city: row.other_city,
        country: null,
        open_to_coffee_chat: false,
        open_to_intros: false,
        organization_name: row.other_org_name,
      },
    }));
  }

  async listPendingConnections(userId: string): Promise<Connection[]> {
    const result = await query<Connection & { other_first_name: string; other_last_name: string; other_slug: string; other_headline: string | null; other_avatar_url: string | null; other_city: string | null; other_org_name: string | null; other_expertise: string[] }>(
      `SELECT c.*,
              u.first_name as other_first_name, u.last_name as other_last_name,
              u.slug as other_slug, u.headline as other_headline,
              u.avatar_url as other_avatar_url, u.city as other_city,
              u.expertise as other_expertise,
              CASE WHEN o.is_personal THEN NULL ELSE o.name END as other_org_name
       FROM connections c
       JOIN users u ON u.workos_user_id = c.requester_user_id
       LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
       WHERE c.recipient_user_id = $1 AND c.status = 'pending'
       ORDER BY c.created_at DESC`,
      [userId]
    );

    return result.rows.map(row => ({
      id: row.id,
      requester_user_id: row.requester_user_id,
      recipient_user_id: row.recipient_user_id,
      status: row.status,
      message: row.message,
      created_at: row.created_at,
      responded_at: row.responded_at,
      other_user: {
        workos_user_id: row.requester_user_id,
        slug: row.other_slug,
        first_name: row.other_first_name,
        last_name: row.other_last_name,
        headline: row.other_headline,
        bio: null,
        avatar_url: row.other_avatar_url,
        expertise: row.other_expertise || [],
        city: row.other_city,
        country: null,
        open_to_coffee_chat: false,
        open_to_intros: false,
        organization_name: row.other_org_name,
      },
    }));
  }

  async listSentConnections(userId: string): Promise<Connection[]> {
    const result = await query<Connection & { other_first_name: string; other_last_name: string; other_slug: string; other_headline: string | null; other_avatar_url: string | null; other_city: string | null; other_org_name: string | null; other_expertise: string[] }>(
      `SELECT c.*,
              u.first_name as other_first_name, u.last_name as other_last_name,
              u.slug as other_slug, u.headline as other_headline,
              u.avatar_url as other_avatar_url, u.city as other_city,
              u.expertise as other_expertise,
              CASE WHEN o.is_personal THEN NULL ELSE o.name END as other_org_name
       FROM connections c
       JOIN users u ON u.workos_user_id = c.recipient_user_id
       LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
       WHERE c.requester_user_id = $1 AND c.status = 'pending'
       ORDER BY c.created_at DESC`,
      [userId]
    );

    return result.rows.map(row => ({
      id: row.id,
      requester_user_id: row.requester_user_id,
      recipient_user_id: row.recipient_user_id,
      status: row.status,
      message: row.message,
      created_at: row.created_at,
      responded_at: row.responded_at,
      other_user: {
        workos_user_id: row.recipient_user_id,
        slug: row.other_slug,
        first_name: row.other_first_name,
        last_name: row.other_last_name,
        headline: row.other_headline,
        bio: null,
        avatar_url: row.other_avatar_url,
        expertise: row.other_expertise || [],
        city: row.other_city,
        country: null,
        open_to_coffee_chat: false,
        open_to_intros: false,
        organization_name: row.other_org_name,
      },
    }));
  }

  async getConnectionStatus(viewerUserId: string, profileUserId: string): Promise<{ status: string; id: string; direction: 'sent' | 'received' } | null> {
    const result = await query<{ status: string; id: string; requester_user_id: string }>(
      `SELECT id, status, requester_user_id FROM connections
       WHERE (requester_user_id = $1 AND recipient_user_id = $2)
          OR (requester_user_id = $2 AND recipient_user_id = $1)
       LIMIT 1`,
      [viewerUserId, profileUserId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      id: row.id,
      direction: row.requester_user_id === viewerUserId ? 'sent' : 'received',
    };
  }

  async getConnectionCount(userId: string): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM connections
       WHERE (requester_user_id = $1 OR recipient_user_id = $1)
         AND status = 'accepted'`,
      [userId]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  async getPendingRequestCount(userId: string): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM connections
       WHERE recipient_user_id = $1 AND status = 'pending'`,
      [userId]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  // =====================================================
  // POINTS & BADGES
  // =====================================================

  async awardPoints(userId: string, action: string, points: number, referenceId?: string, referenceType?: string): Promise<void> {
    await query(
      `INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
       DO NOTHING`,
      [userId, action, points, referenceId || null, referenceType || null]
    );
  }

  async getUserPoints(userId: string): Promise<number> {
    const result = await query<{ total: string }>(
      `SELECT COALESCE(SUM(points), 0) as total FROM community_points WHERE workos_user_id = $1`,
      [userId]
    );
    return parseInt(result.rows[0]?.total || '0', 10);
  }

  async getUserBadges(userId: string): Promise<Badge[]> {
    const result = await query<Badge & { awarded_at: string }>(
      `SELECT b.id, b.name, b.description, b.icon, b.category, ub.awarded_at
       FROM user_badges ub
       JOIN badges b ON b.id = ub.badge_id
       WHERE ub.workos_user_id = $1
       ORDER BY ub.awarded_at DESC`,
      [userId]
    );
    return result.rows;
  }

  async awardBadge(userId: string, badgeId: string): Promise<void> {
    await query(
      `INSERT INTO user_badges (workos_user_id, badge_id)
       VALUES ($1, $2)
       ON CONFLICT (workos_user_id, badge_id) DO NOTHING`,
      [userId, badgeId]
    );
  }

  /**
   * Check badge thresholds and award any that have been earned.
   * Safe to call repeatedly — uses ON CONFLICT DO NOTHING.
   */
  async checkAndAwardBadges(userId: string, context: 'connection' | 'profile' | 'event' | 'wg' | 'content'): Promise<string[]> {
    const awarded: string[] = [];

    if (context === 'connection') {
      const count = await this.getConnectionCount(userId);
      if (count >= 10) {
        await this.awardBadge(userId, 'connector');
        awarded.push('connector');
      }
      if (count >= 25) {
        await this.awardBadge(userId, 'networker');
        awarded.push('networker');
      }
    }

    if (context === 'profile') {
      const profile = await this.getProfile(userId);
      if (profile) {
        const completeness = this.getProfileCompleteness(profile);
        if (completeness === 100) {
          await this.awardBadge(userId, 'profile_complete');
          awarded.push('profile_complete');
        }
      }
    }

    if (context === 'event') {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM event_registrations WHERE workos_user_id = $1`,
        [userId]
      );
      const count = parseInt(result.rows[0]?.count || '0', 10);
      if (count >= 3) {
        await this.awardBadge(userId, 'event_regular');
        awarded.push('event_regular');
      }
    }

    if (context === 'wg') {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM working_group_memberships WHERE workos_user_id = $1 AND status = 'active'`,
        [userId]
      );
      const count = parseInt(result.rows[0]?.count || '0', 10);
      if (count >= 1) {
        await this.awardBadge(userId, 'working_group_member');
        awarded.push('working_group_member');
      }
    }

    if (context === 'content') {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM perspectives WHERE author_user_id = $1 AND status = 'published'`,
        [userId]
      );
      const count = parseInt(result.rows[0]?.count || '0', 10);
      if (count >= 1) {
        await this.awardBadge(userId, 'contributor');
        awarded.push('contributor');
      }
    }

    return awarded;
  }

  /**
   * Award daily visit points (2 pts, once per day).
   * Uses a date-based dedup to prevent multiple awards on the same day.
   */
  async awardDailyVisit(userId: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const result = await query(
      `INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type)
       VALUES ($1, 'daily_visit', 2, $2, 'visit')
       ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
       DO NOTHING`,
      [userId, today]
    );
    return (result.rowCount ?? 0) > 0;
  }

  getTierName(points: number): string {
    if (points >= 1500) return 'Pioneer';
    if (points >= 500) return 'Champion';
    if (points >= 100) return 'Connector';
    return 'Explorer';
  }

  // =====================================================
  // DISCOVERY
  // =====================================================

  async getDistinctExpertise(): Promise<string[]> {
    const result = await query<{ tag: string }>(
      `SELECT DISTINCT UNNEST(expertise) as tag FROM users WHERE is_public = true AND expertise != '{}' ORDER BY tag`
    );
    return result.rows.map(r => r.tag);
  }

  async getRecentPublicProfiles(limit: number = 5): Promise<PersonListItem[]> {
    const result = await query<PersonListItem>(
      `SELECT u.workos_user_id, u.slug, u.first_name, u.last_name, u.headline,
              u.avatar_url, u.expertise, u.city, u.country,
              u.open_to_coffee_chat, u.open_to_intros,
              CASE WHEN o.is_personal THEN NULL ELSE o.name END as organization_name
       FROM users u
       LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
       WHERE u.is_public = true AND u.slug IS NOT NULL
       ORDER BY u.updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  // =====================================================
  // SUGGESTED CONNECTIONS
  // =====================================================

  async getSuggestedConnections(userId: string, limit: number = 4): Promise<(PersonListItem & { suggestion_context: string | null })[]> {
    // Score people by shared attributes, exclude existing connections
    const result = await query<PersonListItem & { score: number; suggestion_context: string | null }>(
      `WITH user_data AS (
        SELECT city, expertise, workos_user_id
        FROM users WHERE workos_user_id = $1
      ),
      user_wgs AS (
        SELECT working_group_id FROM working_group_memberships
        WHERE workos_user_id = $1 AND status = 'active'
      ),
      user_events AS (
        SELECT event_id FROM event_registrations WHERE workos_user_id = $1
      ),
      existing_connections AS (
        SELECT CASE
          WHEN requester_user_id = $1 THEN recipient_user_id
          ELSE requester_user_id
        END as connected_user_id
        FROM connections
        WHERE (requester_user_id = $1 OR recipient_user_id = $1)
      )
      SELECT u.workos_user_id, u.slug, u.first_name, u.last_name, u.headline, u.bio,
             u.avatar_url, u.expertise, u.city, u.country,
             u.open_to_coffee_chat, u.open_to_intros,
             CASE WHEN o.is_personal THEN NULL ELSE o.name END as organization_name,
             (
               CASE WHEN u.city IS NOT NULL AND u.city = ud.city THEN 3 ELSE 0 END +
               CASE WHEN u.expertise && ud.expertise THEN 1 ELSE 0 END +
               (SELECT COUNT(*) FROM user_wgs uw
                JOIN working_group_memberships wgm ON wgm.working_group_id = uw.working_group_id
                WHERE wgm.workos_user_id = u.workos_user_id AND wgm.status = 'active') * 2 +
               (SELECT COUNT(*) FROM user_events ue
                JOIN event_registrations er ON er.event_id = ue.event_id
                WHERE er.workos_user_id = u.workos_user_id) * 2
             ) as score,
             CASE
               WHEN u.city IS NOT NULL AND u.city = ud.city THEN 'Same city'
               WHEN (SELECT COUNT(*) FROM user_wgs uw
                     JOIN working_group_memberships wgm ON wgm.working_group_id = uw.working_group_id
                     WHERE wgm.workos_user_id = u.workos_user_id AND wgm.status = 'active') > 0
                 THEN 'Shared working group'
               WHEN (SELECT COUNT(*) FROM user_events ue
                     JOIN event_registrations er ON er.event_id = ue.event_id
                     WHERE er.workos_user_id = u.workos_user_id) > 0
                 THEN 'Co-attended event'
               WHEN u.expertise && ud.expertise THEN 'Shared expertise'
               ELSE NULL
             END as suggestion_context
      FROM users u
      CROSS JOIN user_data ud
      LEFT JOIN organizations o ON o.workos_organization_id = u.primary_organization_id
      WHERE u.workos_user_id != $1
        AND u.is_public = true
        AND u.slug IS NOT NULL
        AND u.workos_user_id NOT IN (SELECT connected_user_id FROM existing_connections)
      ORDER BY score DESC, u.engagement_score DESC NULLS LAST
      LIMIT $2`,
      [userId, limit]
    );

    return result.rows;
  }

  // =====================================================
  // HUB DATA AGGREGATION
  // =====================================================

  async getHubData(userId: string): Promise<HubData> {
    // Fetch user profile
    const profileResult = await query<CommunityProfile & { first_name: string; last_name: string; city: string | null; country: string | null }>(
      `SELECT workos_user_id, slug, headline, bio, avatar_url, expertise, interests,
              linkedin_url, twitter_url, github_username, is_public, open_to_coffee_chat, open_to_intros,
              first_name, last_name, city, country
       FROM users WHERE workos_user_id = $1`,
      [userId]
    );

    const profile = profileResult.rows[0];
    if (!profile) {
      throw new Error('User not found');
    }

    // Parallel fetch all hub data
    const [
      totalPoints,
      badges,
      suggestedConnections,
      recentProfiles,
      upcomingEvents,
      workingGroups,
      connectionCount,
      pendingRequestCount,
    ] = await Promise.all([
      this.getUserPoints(userId),
      this.getUserBadges(userId),
      this.getSuggestedConnections(userId, 4),
      this.getRecentPublicProfiles(5),
      this.getUpcomingEvents(userId),
      this.getUserWorkingGroupsWithCount(userId),
      this.getConnectionCount(userId),
      this.getPendingRequestCount(userId),
    ]);

    return {
      profile,
      profile_completeness: this.getProfileCompleteness(profile),
      total_points: totalPoints,
      tier: this.getTierName(totalPoints),
      badges,
      suggested_connections: suggestedConnections,
      recent_profiles: recentProfiles.filter(p => p.workos_user_id !== userId),
      upcoming_events: upcomingEvents,
      working_groups: workingGroups,
      connection_count: connectionCount,
      pending_request_count: pendingRequestCount,
    };
  }

  private async getUpcomingEvents(userId: string): Promise<{ id: string; title: string; start_time: string; co_attendee_count: number }[]> {
    const result = await query<{ id: string; title: string; start_time: string; co_attendee_count: number }>(
      `SELECT e.id, e.title, e.start_time,
              (SELECT COUNT(*) FROM event_registrations er2
               WHERE er2.event_id = e.id AND er2.workos_user_id != $1) as co_attendee_count
       FROM events e
       JOIN event_registrations er ON er.event_id = e.id
       WHERE er.workos_user_id = $1
         AND e.start_time > NOW()
         AND e.status = 'published'
       ORDER BY e.start_time ASC
       LIMIT 5`,
      [userId]
    );
    return result.rows;
  }

  private async getUserWorkingGroupsWithCount(userId: string): Promise<{ id: string; name: string; slug: string; member_count: number }[]> {
    const result = await query<{ id: string; name: string; slug: string; member_count: number }>(
      `SELECT wg.id, wg.name, wg.slug,
              (SELECT COUNT(*) FROM working_group_memberships wgm2
               WHERE wgm2.working_group_id = wg.id AND wgm2.status = 'active') as member_count
       FROM working_groups wg
       JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
       WHERE wgm.workos_user_id = $1 AND wgm.status = 'active'
       ORDER BY wg.name`,
      [userId]
    );
    return result.rows;
  }
}
