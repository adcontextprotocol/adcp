import { query } from './client.js';
import type {
  WorkingGroup,
  WorkingGroupLeader,
  WorkingGroupMembership,
  CreateWorkingGroupInput,
  UpdateWorkingGroupInput,
  WorkingGroupWithMemberCount,
  WorkingGroupWithDetails,
  AddWorkingGroupMemberInput,
  CommitteeType,
  EventInterestLevel,
  EventInterestSource,
  CommitteeDocument,
  CreateCommitteeDocumentInput,
  UpdateCommitteeDocumentInput,
  CommitteeSummary,
  CommitteeSummaryType,
  CommitteeDocumentActivity,
  DocumentActivityType,
  DocumentIndexStatus,
} from '../types.js';

/**
 * Escape LIKE pattern wildcards to prevent SQL injection
 */
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Extract Slack channel ID from a Slack URL
 * Handles formats like:
 * - https://agenticads.slack.com/archives/C09HEERCY8P
 * - https://app.slack.com/client/T123/C09HEERCY8P
 * Returns null if no valid channel ID found
 */
function extractSlackChannelId(url: string | null | undefined): string | null {
  if (!url) return null;

  // Slack channel IDs start with C (public) or G (private) followed by alphanumeric
  const channelIdPattern = /[CG][A-Z0-9]{8,}/;

  // Try to extract from URL path
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    // Look for channel ID in path segments (usually the last one)
    for (let i = pathParts.length - 1; i >= 0; i--) {
      const match = pathParts[i].match(channelIdPattern);
      if (match) {
        return match[0];
      }
    }
  } catch {
    // If URL parsing fails, try regex on the whole string
    const match = url.match(channelIdPattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

/**
 * Database operations for working groups
 */
export class WorkingGroupDatabase {
  /**
   * Resolve a user ID to its canonical WorkOS user ID.
   * If the ID is a Slack user ID with a linked WorkOS account, returns the WorkOS ID.
   * Otherwise returns the original ID unchanged.
   */
  async resolveToCanonicalUserId(userId: string): Promise<string> {
    // Check if this is a Slack user ID with a linked WorkOS account
    const result = await query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM slack_user_mappings
       WHERE slack_user_id = $1 AND workos_user_id IS NOT NULL`,
      [userId]
    );
    return result.rows[0]?.workos_user_id ?? userId;
  }

  // ============== Working Groups ==============

  /**
   * Create a new working group
   */
  async createWorkingGroup(input: CreateWorkingGroupInput): Promise<WorkingGroup> {
    // Auto-extract channel ID from URL if not explicitly provided
    const channelId = input.slack_channel_id || extractSlackChannelId(input.slack_channel_url);

    const result = await query<WorkingGroup>(
      `INSERT INTO working_groups (
        name, slug, description, slack_channel_url, slack_channel_id,
        is_private, status, display_order, committee_type, region,
        linked_event_id, event_start_date, event_end_date, event_location, auto_archive_after_event,
        logo_url, website_url, topics
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        input.name,
        input.slug,
        input.description || null,
        input.slack_channel_url || null,
        channelId,
        input.is_private ?? false,
        input.status ?? 'active',
        input.display_order ?? 0,
        input.committee_type ?? 'working_group',
        input.region || null,
        input.linked_event_id || null,
        input.event_start_date || null,
        input.event_end_date || null,
        input.event_location || null,
        input.auto_archive_after_event ?? true,
        input.logo_url || null,
        input.website_url || null,
        input.topics ? JSON.stringify(input.topics) : '[]',
      ]
    );

    const workingGroup = result.rows[0];

    // Add leaders if provided
    if (input.leader_user_ids && input.leader_user_ids.length > 0) {
      await this.setLeaders(workingGroup.id, input.leader_user_ids);
      workingGroup.leaders = await this.getLeaders(workingGroup.id);
    }

    return workingGroup;
  }

  /**
   * Get working group by ID
   */
  async getWorkingGroupById(id: string): Promise<WorkingGroup | null> {
    const result = await query<WorkingGroup>(
      'SELECT * FROM working_groups WHERE id = $1',
      [id]
    );
    if (!result.rows[0]) return null;

    const workingGroup = result.rows[0];
    workingGroup.leaders = await this.getLeaders(id);
    return workingGroup;
  }

  /**
   * Get working group by slug
   */
  async getWorkingGroupBySlug(slug: string): Promise<WorkingGroup | null> {
    const result = await query<WorkingGroup>(
      'SELECT * FROM working_groups WHERE slug = $1',
      [slug]
    );
    if (!result.rows[0]) return null;

    const workingGroup = result.rows[0];
    workingGroup.leaders = await this.getLeaders(workingGroup.id);
    return workingGroup;
  }

  /**
   * Update working group
   */
  async updateWorkingGroup(
    id: string,
    updates: UpdateWorkingGroupInput
  ): Promise<WorkingGroup | null> {
    // Auto-extract channel ID from URL if URL is being updated and channel_id isn't explicitly set
    if (updates.slack_channel_url !== undefined && updates.slack_channel_id === undefined) {
      updates.slack_channel_id = extractSlackChannelId(updates.slack_channel_url) ?? undefined;
    }

    const COLUMN_MAP: Record<string, string> = {
      name: 'name',
      slug: 'slug',
      description: 'description',
      slack_channel_url: 'slack_channel_url',
      slack_channel_id: 'slack_channel_id',
      is_private: 'is_private',
      status: 'status',
      display_order: 'display_order',
      committee_type: 'committee_type',
      region: 'region',
      linked_event_id: 'linked_event_id',
      event_start_date: 'event_start_date',
      event_end_date: 'event_end_date',
      event_location: 'event_location',
      auto_archive_after_event: 'auto_archive_after_event',
      logo_url: 'logo_url',
      website_url: 'website_url',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      // Handle leaders separately
      if (key === 'leader_user_ids') continue;
      // Handle topics separately (JSONB)
      if (key === 'topics') continue;

      const columnName = COLUMN_MAP[key];
      if (!columnName) {
        continue;
      }
      setClauses.push(`${columnName} = $${paramIndex++}`);
      params.push(value);
    }

    // Handle topics (JSONB column)
    if (updates.topics !== undefined) {
      setClauses.push(`topics = $${paramIndex++}`);
      params.push(JSON.stringify(updates.topics));
    }

    // Update working group fields if any
    if (setClauses.length > 0) {
      params.push(id);
      const sql = `
        UPDATE working_groups
        SET ${setClauses.join(', ')}, updated_at = NOW()
        WHERE id = $${paramIndex}
        RETURNING *
      `;
      await query<WorkingGroup>(sql, params);
    }

    // Update leaders if provided
    if (updates.leader_user_ids !== undefined) {
      await this.setLeaders(id, updates.leader_user_ids);
    }

    return this.getWorkingGroupById(id);
  }

  /**
   * Delete working group
   */
  async deleteWorkingGroup(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM working_groups WHERE id = $1',
      [id]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * List all working groups with member count
   */
  async listWorkingGroups(options: {
    status?: string;
    includePrivate?: boolean;
    search?: string;
    committee_type?: CommitteeType | CommitteeType[];
    excludeGovernance?: boolean;
  } = {}): Promise<WorkingGroupWithMemberCount[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.status) {
      conditions.push(`wg.status = $${paramIndex++}`);
      params.push(options.status);
    }

    if (!options.includePrivate) {
      conditions.push(`wg.is_private = false`);
    }

    if (options.search) {
      conditions.push(`(wg.name ILIKE $${paramIndex} OR wg.description ILIKE $${paramIndex})`);
      params.push(`%${escapeLikePattern(options.search)}%`);
      paramIndex++;
    }

    // Filter by committee type
    if (options.committee_type) {
      const types = Array.isArray(options.committee_type)
        ? options.committee_type
        : [options.committee_type];
      conditions.push(`wg.committee_type = ANY($${paramIndex++})`);
      params.push(types);
    }

    // Exclude governance committees from public listings
    if (options.excludeGovernance) {
      conditions.push(`wg.committee_type != 'governance'`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(wgm.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id AND wgm.status = 'active'
       ${whereClause}
       GROUP BY wg.id
       ORDER BY wg.display_order, wg.name`,
      params
    );

    // Batch fetch leaders for all groups
    const groups = result.rows;
    const groupIds = groups.map(g => g.id);
    const leadersByGroup = await this.getLeadersBatch(groupIds);

    for (const group of groups) {
      group.leaders = leadersByGroup.get(group.id) || [];
    }

    return groups;
  }

  /**
   * List working groups visible to a specific user (public + private they're a member of)
   */
  async listWorkingGroupsForUser(userId: string, options: {
    committee_type?: CommitteeType | CommitteeType[];
    excludeGovernance?: boolean;
  } = {}): Promise<WorkingGroupWithMemberCount[]> {
    const conditions: string[] = [
      `wg.status = 'active'`,
      `(wg.is_private = false OR EXISTS (
        SELECT 1 FROM working_group_memberships wgm
        WHERE wgm.working_group_id = wg.id
          AND wgm.workos_user_id = $1
          AND wgm.status = 'active'
      ))`,
    ];
    const params: unknown[] = [userId];
    let paramIndex = 2;

    // Filter by committee type
    if (options.committee_type) {
      const types = Array.isArray(options.committee_type)
        ? options.committee_type
        : [options.committee_type];
      conditions.push(`wg.committee_type = ANY($${paramIndex++})`);
      params.push(types);
    }

    // Exclude governance committees from public listings
    if (options.excludeGovernance) {
      conditions.push(`wg.committee_type != 'governance'`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(wgm2.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm2 ON wg.id = wgm2.working_group_id AND wgm2.status = 'active'
       ${whereClause}
       GROUP BY wg.id
       ORDER BY wg.display_order, wg.name`,
      params
    );

    // Batch fetch leaders for all groups
    const groups = result.rows;
    const groupIds = groups.map(g => g.id);
    const leadersByGroup = await this.getLeadersBatch(groupIds);

    for (const group of groups) {
      group.leaders = leadersByGroup.get(group.id) || [];
    }

    return groups;
  }

  /**
   * Get working group with full details including memberships
   */
  async getWorkingGroupWithDetails(id: string): Promise<WorkingGroupWithDetails | null> {
    const wg = await this.getWorkingGroupById(id);
    if (!wg) return null;

    const memberships = await this.getMembershipsByWorkingGroup(id);
    const memberCount = memberships.filter(m => m.status === 'active').length;

    return {
      ...wg,
      member_count: memberCount,
      memberships,
    };
  }

  /**
   * Check if slug is available
   */
  async isSlugAvailable(slug: string, excludeId?: string): Promise<boolean> {
    let sql = 'SELECT 1 FROM working_groups WHERE slug = $1';
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
   * Get working group by Slack channel ID
   */
  async getWorkingGroupBySlackChannelId(slackChannelId: string): Promise<WorkingGroup | null> {
    const result = await query<WorkingGroup>(
      'SELECT * FROM working_groups WHERE slack_channel_id = $1',
      [slackChannelId]
    );
    return result.rows[0] || null;
  }

  /**
   * List working groups that have Slack channel IDs configured
   */
  async listWorkingGroupsWithSlackChannel(): Promise<WorkingGroup[]> {
    const result = await query<WorkingGroup>(
      `SELECT * FROM working_groups
       WHERE slack_channel_id IS NOT NULL AND status = 'active'
       ORDER BY display_order, name`
    );
    return result.rows;
  }

  // ============== Memberships ==============

  /**
   * Add a member to a working group
   */
  async addMembership(input: AddWorkingGroupMemberInput): Promise<WorkingGroupMembership> {
    // Resolve Slack IDs to canonical WorkOS IDs to prevent duplicates
    const canonicalUserId = await this.resolveToCanonicalUserId(input.workos_user_id);

    const result = await query<WorkingGroupMembership>(
      `INSERT INTO working_group_memberships (
        working_group_id, workos_user_id, user_email, user_name, user_org_name,
        workos_organization_id, added_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (working_group_id, workos_user_id)
      DO UPDATE SET status = 'active', updated_at = NOW()
      RETURNING *`,
      [
        input.working_group_id,
        canonicalUserId,
        input.user_email || null,
        input.user_name || null,
        input.user_org_name || null,
        input.workos_organization_id || null,
        input.added_by_user_id || null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Remove a member from a working group (soft delete by setting status to inactive)
   */
  async removeMembership(workingGroupId: string, userId: string): Promise<boolean> {
    const canonicalUserId = await this.resolveToCanonicalUserId(userId);
    const result = await query(
      `UPDATE working_group_memberships
       SET status = 'inactive', updated_at = NOW()
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [workingGroupId, canonicalUserId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Hard delete a membership record
   */
  async deleteMembership(workingGroupId: string, userId: string): Promise<boolean> {
    const canonicalUserId = await this.resolveToCanonicalUserId(userId);
    const result = await query(
      `DELETE FROM working_group_memberships
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [workingGroupId, canonicalUserId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Get a specific membership
   */
  async getMembership(workingGroupId: string, userId: string): Promise<WorkingGroupMembership | null> {
    const canonicalUserId = await this.resolveToCanonicalUserId(userId);
    const result = await query<WorkingGroupMembership>(
      `SELECT * FROM working_group_memberships
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [workingGroupId, canonicalUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if user is a member of a working group
   */
  async isMember(workingGroupId: string, userId: string): Promise<boolean> {
    const canonicalUserId = await this.resolveToCanonicalUserId(userId);
    const result = await query(
      `SELECT 1 FROM working_group_memberships
       WHERE working_group_id = $1 AND workos_user_id = $2 AND status = 'active'
       LIMIT 1`,
      [workingGroupId, canonicalUserId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get all working group IDs a user is a member of
   */
  async getWorkingGroupIdsByUser(userId: string): Promise<string[]> {
    const canonicalUserId = await this.resolveToCanonicalUserId(userId);
    const result = await query<{ working_group_id: string }>(
      `SELECT working_group_id FROM working_group_memberships
       WHERE workos_user_id = $1 AND status = 'active'`,
      [canonicalUserId]
    );
    return result.rows.map(r => r.working_group_id);
  }

  /**
   * Get all memberships for a working group
   */
  async getMembershipsByWorkingGroup(workingGroupId: string): Promise<WorkingGroupMembership[]> {
    // Get memberships with user details from multiple sources:
    // 1. working_group_memberships.user_name (cached)
    // 2. users table (canonical from WorkOS)
    // 3. organization_memberships (older sync)
    // 4. Falls back to user_id if no name found
    const result = await query<WorkingGroupMembership>(
      `SELECT
         wgm.id,
         wgm.working_group_id,
         wgm.workos_user_id,
         wgm.workos_organization_id,
         wgm.added_by_user_id,
         wgm.status,
         wgm.joined_at,
         wgm.updated_at,
         wgm.interest_level,
         wgm.interest_source,
         COALESCE(
           NULLIF(wgm.user_name, ''),
           NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
           NULLIF(TRIM(CONCAT(om.first_name, ' ', om.last_name)), ''),
           u.email,
           om.email,
           wgm.workos_user_id
         ) AS user_name,
         COALESCE(wgm.user_email, u.email, om.email) AS user_email,
         COALESCE(wgm.user_org_name, user_org.name, org.name) AS user_org_name
       FROM working_group_memberships wgm
       LEFT JOIN users u ON wgm.workos_user_id = u.workos_user_id
       LEFT JOIN organizations user_org ON u.primary_organization_id = user_org.workos_organization_id
       LEFT JOIN LATERAL (
         SELECT om.first_name, om.last_name, om.email, om.workos_organization_id
         FROM organization_memberships om
         WHERE om.workos_user_id = wgm.workos_user_id
         ORDER BY om.created_at DESC
         LIMIT 1
       ) om ON true
       LEFT JOIN organizations org ON om.workos_organization_id = org.workos_organization_id
       WHERE wgm.working_group_id = $1 AND wgm.status = 'active'
       ORDER BY user_name, user_email`,
      [workingGroupId]
    );
    return result.rows;
  }

  /**
   * Get all working groups a user is a member of
   */
  async getWorkingGroupsForUser(userId: string): Promise<WorkingGroup[]> {
    const result = await query<WorkingGroup>(
      `SELECT wg.* FROM working_groups wg
       INNER JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id
       WHERE wgm.workos_user_id = $1 AND wgm.status = 'active' AND wg.status = 'active'
       ORDER BY wg.display_order, wg.name`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Get all working groups that users from an organization are members of
   * (for displaying on org member profiles)
   */
  async getWorkingGroupsForOrganization(orgId: string): Promise<WorkingGroup[]> {
    const result = await query<WorkingGroup>(
      `SELECT DISTINCT wg.* FROM working_groups wg
       INNER JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id
       WHERE wgm.workos_organization_id = $1 AND wgm.status = 'active' AND wg.status = 'active'
       ORDER BY wg.display_order, wg.name`,
      [orgId]
    );
    return result.rows;
  }

  // ============== Leaders ==============

  /**
   * Get leaders for a working group
   */
  async getLeaders(workingGroupId: string): Promise<WorkingGroupLeader[]> {
    // Get leaders with user details from multiple sources:
    // 1. working_group_memberships (if they're a member with cached name)
    // 2. users table (canonical user data synced from WorkOS)
    // 3. organization_memberships (older sync table)
    // 4. slack_user_mappings (Slack profile name for unmapped Slack users)
    // 5. Falls back to user_id if no name found
    //
    // canonical_user_id is resolved at read time via slack_user_mappings
    // to handle cases where leaders were added via Slack ID before linking WorkOS
    const result = await query<WorkingGroupLeader>(
      `SELECT
         wgl.user_id,
         COALESCE(sm.workos_user_id, wgl.user_id) AS canonical_user_id,
         COALESCE(
           NULLIF(wgm.user_name, ''),
           NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
           NULLIF(TRIM(CONCAT(om.first_name, ' ', om.last_name)), ''),
           u.email,
           om.email,
           NULLIF(slack_profile.slack_real_name, ''),
           NULLIF(slack_profile.slack_display_name, ''),
           wgl.user_id
         ) AS name,
         COALESCE(wgm.user_org_name, user_org.name, org.name) AS org_name,
         wgl.created_at
       FROM working_group_leaders wgl
       -- sm: resolves Slack ID -> WorkOS ID (only for linked users)
       LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
       -- slack_profile: gets Slack profile name (for all Slack users, including unlinked)
       LEFT JOIN slack_user_mappings slack_profile ON wgl.user_id = slack_profile.slack_user_id
       LEFT JOIN working_group_memberships wgm ON COALESCE(sm.workos_user_id, wgl.user_id) = wgm.workos_user_id AND wgm.working_group_id = wgl.working_group_id
       LEFT JOIN users u ON COALESCE(sm.workos_user_id, wgl.user_id) = u.workos_user_id
       LEFT JOIN organizations user_org ON u.primary_organization_id = user_org.workos_organization_id
       LEFT JOIN LATERAL (
         SELECT om.first_name, om.last_name, om.email, om.workos_organization_id
         FROM organization_memberships om
         WHERE om.workos_user_id = COALESCE(sm.workos_user_id, wgl.user_id)
         ORDER BY om.created_at DESC
         LIMIT 1
       ) om ON true
       LEFT JOIN organizations org ON om.workos_organization_id = org.workos_organization_id
       WHERE wgl.working_group_id = $1
       ORDER BY wgl.created_at`,
      [workingGroupId]
    );

    return result.rows;
  }

  /**
   * Get leaders for multiple working groups in a single query (batch)
   */
  async getLeadersBatch(workingGroupIds: string[]): Promise<Map<string, WorkingGroupLeader[]>> {
    if (workingGroupIds.length === 0) {
      return new Map();
    }

    // canonical_user_id is resolved at read time via slack_user_mappings
    // to handle cases where leaders were added via Slack ID before linking WorkOS
    const result = await query<WorkingGroupLeader & { working_group_id: string }>(
      `SELECT
         wgl.working_group_id,
         wgl.user_id,
         COALESCE(sm.workos_user_id, wgl.user_id) AS canonical_user_id,
         COALESCE(
           NULLIF(wgm.user_name, ''),
           NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
           NULLIF(TRIM(CONCAT(om.first_name, ' ', om.last_name)), ''),
           u.email,
           om.email,
           NULLIF(slack_profile.slack_real_name, ''),
           NULLIF(slack_profile.slack_display_name, ''),
           wgl.user_id
         ) AS name,
         COALESCE(wgm.user_org_name, user_org.name, org.name) AS org_name,
         wgl.created_at
       FROM working_group_leaders wgl
       -- sm: resolves Slack ID -> WorkOS ID (only for linked users)
       LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
       -- slack_profile: gets Slack profile name (for all Slack users, including unlinked)
       LEFT JOIN slack_user_mappings slack_profile ON wgl.user_id = slack_profile.slack_user_id
       LEFT JOIN working_group_memberships wgm ON COALESCE(sm.workos_user_id, wgl.user_id) = wgm.workos_user_id AND wgm.working_group_id = wgl.working_group_id
       LEFT JOIN users u ON COALESCE(sm.workos_user_id, wgl.user_id) = u.workos_user_id
       LEFT JOIN organizations user_org ON u.primary_organization_id = user_org.workos_organization_id
       LEFT JOIN LATERAL (
         SELECT om.first_name, om.last_name, om.email, om.workos_organization_id
         FROM organization_memberships om
         WHERE om.workos_user_id = COALESCE(sm.workos_user_id, wgl.user_id)
         ORDER BY om.created_at DESC
         LIMIT 1
       ) om ON true
       LEFT JOIN organizations org ON om.workos_organization_id = org.workos_organization_id
       WHERE wgl.working_group_id = ANY($1)
       ORDER BY wgl.created_at`,
      [workingGroupIds]
    );

    // Group by working_group_id
    const leadersByGroup = new Map<string, WorkingGroupLeader[]>();
    for (const row of result.rows) {
      const groupId = row.working_group_id;
      if (!leadersByGroup.has(groupId)) {
        leadersByGroup.set(groupId, []);
      }
      leadersByGroup.get(groupId)!.push({
        user_id: row.user_id,
        canonical_user_id: row.canonical_user_id,
        name: row.name,
        org_name: row.org_name,
        created_at: row.created_at,
      });
    }

    return leadersByGroup;
  }

  /**
   * Set leaders for a working group (replaces existing leaders)
   */
  async setLeaders(workingGroupId: string, userIds: string[]): Promise<void> {
    // Resolve all Slack IDs to canonical WorkOS IDs to prevent duplicates
    const canonicalUserIds = await Promise.all(
      userIds.map(id => this.resolveToCanonicalUserId(id))
    );
    // Dedupe in case multiple Slack IDs resolve to the same WorkOS ID
    const uniqueUserIds = [...new Set(canonicalUserIds)];

    // Remove existing leaders
    await query(
      'DELETE FROM working_group_leaders WHERE working_group_id = $1',
      [workingGroupId]
    );

    // Add new leaders in a single bulk insert
    if (uniqueUserIds.length > 0) {
      const values = uniqueUserIds.map((_, i) => `($1, $${i + 2})`).join(', ');
      await query(
        `INSERT INTO working_group_leaders (working_group_id, user_id)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [workingGroupId, ...uniqueUserIds]
      );
    }

    // Ensure leaders are members
    await this.ensureLeadersAreMembers(workingGroupId);
  }

  /**
   * Add a leader to a working group
   */
  async addLeader(workingGroupId: string, userId: string): Promise<void> {
    // Resolve Slack IDs to canonical WorkOS IDs to prevent duplicates
    const canonicalUserId = await this.resolveToCanonicalUserId(userId);

    await query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [workingGroupId, canonicalUserId]
    );

    // Ensure leader is a member
    await this.ensureLeadersAreMembers(workingGroupId);
  }

  /**
   * Remove a leader from a working group
   */
  async removeLeader(workingGroupId: string, userId: string): Promise<void> {
    const canonicalUserId = await this.resolveToCanonicalUserId(userId);
    await query(
      'DELETE FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [workingGroupId, canonicalUserId]
    );
  }

  /**
   * Check if a user is a leader of a working group
   * Handles both WorkOS and Slack user IDs by checking both directions of the mapping
   */
  async isLeader(workingGroupId: string, userId: string): Promise<boolean> {
    // Check if:
    // 1. The leader record has the user ID directly, OR
    // 2. The leader record has a Slack ID that maps to this WorkOS user ID
    const result = await query(
      `SELECT 1 FROM working_group_leaders wgl
       LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
       WHERE wgl.working_group_id = $1
         AND (wgl.user_id = $2 OR sm.workos_user_id = $2)
       LIMIT 1`,
      [workingGroupId, userId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get all committees led by a user
   * Returns committees of all types where the user is a leader
   * Handles both WorkOS and Slack user IDs by checking both directions of the mapping
   */
  async getCommitteesLedByUser(userId: string): Promise<WorkingGroupWithMemberCount[]> {
    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(DISTINCT wgm.id)::int AS member_count
       FROM working_groups wg
       INNER JOIN working_group_leaders wgl ON wg.id = wgl.working_group_id
       LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
       LEFT JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id AND wgm.status = 'active'
       WHERE (wgl.user_id = $1 OR sm.workos_user_id = $1)
         AND wg.status = 'active'
       GROUP BY wg.id
       ORDER BY wg.display_order, wg.name`,
      [userId]
    );

    const groups = result.rows;
    const groupIds = groups.map(g => g.id);
    const leadersByGroup = await this.getLeadersBatch(groupIds);

    for (const group of groups) {
      group.leaders = leadersByGroup.get(group.id) || [];
    }

    return groups;
  }

  /**
   * Ensure leaders are members of their working group
   */
  async ensureLeadersAreMembers(workingGroupId: string): Promise<void> {
    const leaders = await this.getLeaders(workingGroupId);

    for (const leader of leaders) {
      const existing = await this.getMembership(workingGroupId, leader.user_id);
      if (!existing || existing.status !== 'active') {
        await this.addMembership({
          working_group_id: workingGroupId,
          workos_user_id: leader.user_id,
          user_name: leader.name,
          user_org_name: leader.org_name,
        });
      }
    }
  }

  /**
   * Search users across all member organizations (for leader selection)
   * Returns users with their organization info
   */
  async searchUsersForLeadership(searchTerm: string, limit: number = 20): Promise<Array<{
    user_id: string;
    email: string;
    name: string;
    org_id: string;
    org_name: string;
  }>> {
    // This queries the organization_memberships table to find users
    // and joins with organizations to get org names
    const result = await query<{
      user_id: string;
      email: string;
      name: string;
      org_id: string;
      org_name: string;
    }>(
      `SELECT DISTINCT
         om.workos_user_id AS user_id,
         om.email,
         COALESCE(om.first_name || ' ' || om.last_name, om.email) AS name,
         om.workos_organization_id AS org_id,
         o.name AS org_name
       FROM organization_memberships om
       INNER JOIN organizations o ON om.workos_organization_id = o.workos_organization_id
       WHERE (om.email ILIKE $1 OR om.first_name ILIKE $1 OR om.last_name ILIKE $1 OR o.name ILIKE $1)
       ORDER BY name
       LIMIT $2`,
      [`%${escapeLikePattern(searchTerm)}%`, limit]
    );

    return result.rows;
  }

  /**
   * Get all users with their working group memberships (for admin users page)
   */
  async getAllUsersWithWorkingGroups(options: {
    search?: string;
    filterByGroup?: string; // working_group_id - show only members of this group
    filterNoGroups?: boolean; // show only users with no groups
  } = {}): Promise<Array<{
    user_id: string;
    email: string;
    name: string;
    org_id: string;
    org_name: string;
    working_groups: Array<{
      id: string;
      name: string;
      slug: string;
      is_private: boolean;
    }>;
  }>> {
    // First get all users from organization_memberships
    let userQuery = `
      SELECT DISTINCT
        om.workos_user_id AS user_id,
        om.email,
        COALESCE(NULLIF(TRIM(om.first_name || ' ' || om.last_name), ''), om.email) AS name,
        om.workos_organization_id AS org_id,
        o.name AS org_name
      FROM organization_memberships om
      INNER JOIN organizations o ON om.workos_organization_id = o.workos_organization_id
    `;

    const params: unknown[] = [];
    const conditions: string[] = [];
    let paramIndex = 1;

    if (options.search) {
      conditions.push(`(om.email ILIKE $${paramIndex} OR om.first_name ILIKE $${paramIndex} OR om.last_name ILIKE $${paramIndex} OR o.name ILIKE $${paramIndex})`);
      params.push(`%${escapeLikePattern(options.search)}%`);
      paramIndex++;
    }

    if (options.filterByGroup) {
      conditions.push(`EXISTS (
        SELECT 1 FROM working_group_memberships wgm
        WHERE wgm.workos_user_id = om.workos_user_id
          AND wgm.working_group_id = $${paramIndex}
          AND wgm.status = 'active'
      )`);
      params.push(options.filterByGroup);
      paramIndex++;
    }

    if (options.filterNoGroups) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM working_group_memberships wgm
        WHERE wgm.workos_user_id = om.workos_user_id AND wgm.status = 'active'
      )`);
    }

    if (conditions.length > 0) {
      userQuery += ` WHERE ${conditions.join(' AND ')}`;
    }

    userQuery += ` ORDER BY name`;

    const userResult = await query<{
      user_id: string;
      email: string;
      name: string;
      org_id: string;
      org_name: string;
    }>(userQuery, params);

    // Now get all working group memberships for these users
    const userIds = userResult.rows.map(u => u.user_id);
    if (userIds.length === 0) {
      return [];
    }

    const membershipResult = await query<{
      workos_user_id: string;
      working_group_id: string;
      group_name: string;
      group_slug: string;
      is_private: boolean;
    }>(
      `SELECT
         wgm.workos_user_id,
         wg.id AS working_group_id,
         wg.name AS group_name,
         wg.slug AS group_slug,
         wg.is_private
       FROM working_group_memberships wgm
       INNER JOIN working_groups wg ON wgm.working_group_id = wg.id
       WHERE wgm.workos_user_id = ANY($1)
         AND wgm.status = 'active'
         AND wg.status = 'active'
       ORDER BY wg.display_order, wg.name`,
      [userIds]
    );

    // Group memberships by user
    const membershipsByUser = new Map<string, Array<{
      id: string;
      name: string;
      slug: string;
      is_private: boolean;
    }>>();

    for (const m of membershipResult.rows) {
      if (!membershipsByUser.has(m.workos_user_id)) {
        membershipsByUser.set(m.workos_user_id, []);
      }
      membershipsByUser.get(m.workos_user_id)!.push({
        id: m.working_group_id,
        name: m.group_name,
        slug: m.group_slug,
        is_private: m.is_private,
      });
    }

    // Combine users with their working groups
    return userResult.rows.map(u => ({
      ...u,
      working_groups: membershipsByUser.get(u.user_id) || [],
    }));
  }

  /**
   * Get all working group memberships across all groups (for admin export/view)
   */
  async getAllMemberships(): Promise<Array<{
    user_id: string;
    user_email: string;
    user_name: string;
    user_org_name: string;
    working_group_id: string;
    working_group_name: string;
    working_group_slug: string;
    is_private: boolean;
    joined_at: Date;
  }>> {
    const result = await query<{
      user_id: string;
      user_email: string;
      user_name: string;
      user_org_name: string;
      working_group_id: string;
      working_group_name: string;
      working_group_slug: string;
      is_private: boolean;
      joined_at: Date;
    }>(
      `SELECT
         wgm.workos_user_id AS user_id,
         wgm.user_email,
         wgm.user_name,
         wgm.user_org_name,
         wg.id AS working_group_id,
         wg.name AS working_group_name,
         wg.slug AS working_group_slug,
         wg.is_private,
         wgm.joined_at
       FROM working_group_memberships wgm
       INNER JOIN working_groups wg ON wgm.working_group_id = wg.id
       WHERE wgm.status = 'active' AND wg.status = 'active'
       ORDER BY wgm.user_name, wg.display_order, wg.name`
    );

    return result.rows;
  }

  // ============== Event Groups ==============

  /**
   * Create an event group linked to an event
   */
  async createEventGroup(input: {
    name: string;
    slug: string;
    description?: string;
    linked_event_id: string;
    event_start_date?: Date;
    event_end_date?: Date;
    slack_channel_url?: string;
    slack_channel_id?: string;
    leader_user_ids?: string[];
  }): Promise<WorkingGroup> {
    return this.createWorkingGroup({
      ...input,
      committee_type: 'industry_gathering',
      is_private: false,
      auto_archive_after_event: true,
    });
  }

  /**
   * Get industry gathering group by linked event ID
   */
  async getIndustryGatheringByEventId(eventId: string): Promise<WorkingGroup | null> {
    const result = await query<WorkingGroup>(
      `SELECT * FROM working_groups
       WHERE linked_event_id = $1 AND committee_type = 'industry_gathering'`,
      [eventId]
    );
    if (!result.rows[0]) return null;

    const workingGroup = result.rows[0];
    workingGroup.leaders = await this.getLeaders(workingGroup.id);
    return workingGroup;
  }

  /**
   * Get upcoming industry gatherings (that haven't ended yet)
   */
  async getUpcomingIndustryGatherings(): Promise<WorkingGroupWithMemberCount[]> {
    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(wgm.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id AND wgm.status = 'active'
       WHERE wg.committee_type = 'industry_gathering'
         AND wg.status = 'active'
         AND (wg.event_end_date IS NULL OR wg.event_end_date >= CURRENT_DATE)
       GROUP BY wg.id
       ORDER BY wg.event_start_date ASC NULLS LAST`
    );

    const groups = result.rows;
    const groupIds = groups.map(g => g.id);
    const leadersByGroup = await this.getLeadersBatch(groupIds);

    for (const group of groups) {
      group.leaders = leadersByGroup.get(group.id) || [];
    }

    return groups;
  }

  /**
   * Get past industry gatherings (for archival reference)
   */
  async getPastIndustryGatherings(): Promise<WorkingGroupWithMemberCount[]> {
    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(wgm.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id AND wgm.status = 'active'
       WHERE wg.committee_type = 'industry_gathering'
         AND wg.event_end_date < CURRENT_DATE
       GROUP BY wg.id
       ORDER BY wg.event_end_date DESC`
    );

    return result.rows;
  }

  // ============== Chapters ==============

  /**
   * Get all regional chapters
   */
  async getChapters(): Promise<WorkingGroupWithMemberCount[]> {
    return this.listWorkingGroups({
      status: 'active',
      committee_type: 'chapter',
      includePrivate: false,
    });
  }

  /**
   * Get chapters with their Slack channel info for outreach messages
   */
  async getChapterSlackLinks(): Promise<Array<{
    id: string;
    name: string;
    slug: string;
    region: string;
    slack_channel_url: string;
    slack_channel_id: string;
    member_count: number;
  }>> {
    const result = await query<{
      id: string;
      name: string;
      slug: string;
      region: string;
      slack_channel_url: string;
      slack_channel_id: string;
      member_count: number;
    }>(
      `SELECT
         wg.id,
         wg.name,
         wg.slug,
         wg.region,
         wg.slack_channel_url,
         wg.slack_channel_id,
         COUNT(wgm.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id AND wgm.status = 'active'
       WHERE wg.committee_type = 'chapter'
         AND wg.status = 'active'
         AND wg.slack_channel_id IS NOT NULL
       GROUP BY wg.id
       ORDER BY wg.region, wg.name`
    );

    return result.rows;
  }

  /**
   * Find chapters near a given city/region
   * Simple string matching for now - could be enhanced with geo lookup later
   */
  async findChaptersNearLocation(city: string): Promise<WorkingGroupWithMemberCount[]> {
    // Escape LIKE wildcards to prevent pattern injection
    const escapedCity = escapeLikePattern(city.toLowerCase());

    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(wgm.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm ON wg.id = wgm.working_group_id AND wgm.status = 'active'
       WHERE wg.committee_type = 'chapter'
         AND wg.status = 'active'
         AND (LOWER(wg.region) LIKE $1 OR LOWER(wg.name) LIKE $1)
       GROUP BY wg.id
       ORDER BY wg.name`,
      [`%${escapedCity}%`]
    );

    return result.rows;
  }

  /**
   * Create a new regional chapter with Slack channel
   */
  async createChapter(input: {
    name: string;
    slug: string;
    region: string;
    description?: string;
    slack_channel_url?: string;
    slack_channel_id?: string;
    founding_member_id?: string;
  }): Promise<WorkingGroup> {
    const chapter = await this.createWorkingGroup({
      name: input.name,
      slug: input.slug,
      region: input.region,
      description: input.description || `Connect with AgenticAdvertising.org members in the ${input.region} area.`,
      slack_channel_url: input.slack_channel_url,
      slack_channel_id: input.slack_channel_id,
      committee_type: 'chapter',
      is_private: false,
      leader_user_ids: input.founding_member_id ? [input.founding_member_id] : undefined,
    });

    return chapter;
  }

  /**
   * Create a new industry gathering (temporary committee for conferences/events)
   */
  async createIndustryGathering(input: {
    name: string;
    slug: string;
    description?: string;
    slack_channel_url?: string;
    slack_channel_id?: string;
    start_date: Date;
    end_date?: Date;
    location: string;
    website_url?: string;
    logo_url?: string;
    founding_member_id?: string;
  }): Promise<WorkingGroup> {
    // Generate the full slug: industry-gatherings/YYYY/name
    const year = input.start_date.getFullYear();
    const fullSlug = `industry-gatherings/${year}/${input.slug}`;

    const gathering = await this.createWorkingGroup({
      name: input.name,
      slug: fullSlug,
      description: input.description || `Connect with AgenticAdvertising.org members at ${input.name}.`,
      slack_channel_url: input.slack_channel_url,
      slack_channel_id: input.slack_channel_id,
      committee_type: 'industry_gathering',
      is_private: false,
      event_start_date: input.start_date,
      event_end_date: input.end_date,
      event_location: input.location,
      website_url: input.website_url,
      logo_url: input.logo_url,
      auto_archive_after_event: true,
      leader_user_ids: input.founding_member_id ? [input.founding_member_id] : undefined,
    });

    return gathering;
  }

  /**
   * Get all active industry gatherings
   */
  async getIndustryGatherings(): Promise<WorkingGroupWithMemberCount[]> {
    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(wgm.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id AND wgm.status = 'active'
       WHERE wg.committee_type = 'industry_gathering'
         AND wg.status = 'active'
       GROUP BY wg.id
       ORDER BY wg.event_start_date DESC NULLS LAST, wg.name ASC`
    );
    return result.rows;
  }

  // ============== Membership with Interest Tracking ==============

  /**
   * Add a member with interest level tracking (for event groups)
   */
  async addMembershipWithInterest(input: AddWorkingGroupMemberInput & {
    interest_level?: EventInterestLevel;
    interest_source?: EventInterestSource;
  }): Promise<WorkingGroupMembership> {
    // Resolve Slack IDs to canonical WorkOS IDs to prevent duplicates
    const canonicalUserId = await this.resolveToCanonicalUserId(input.workos_user_id);

    const result = await query<WorkingGroupMembership>(
      `INSERT INTO working_group_memberships (
        working_group_id, workos_user_id, user_email, user_name, user_org_name,
        workos_organization_id, added_by_user_id, interest_level, interest_source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (working_group_id, workos_user_id)
      DO UPDATE SET
        status = 'active',
        interest_level = COALESCE(EXCLUDED.interest_level, working_group_memberships.interest_level),
        interest_source = COALESCE(EXCLUDED.interest_source, working_group_memberships.interest_source),
        updated_at = NOW()
      RETURNING *`,
      [
        input.working_group_id,
        canonicalUserId,
        input.user_email || null,
        input.user_name || null,
        input.user_org_name || null,
        input.workos_organization_id || null,
        input.added_by_user_id || null,
        input.interest_level || null,
        input.interest_source || null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Update member interest level
   */
  async updateMemberInterest(
    workingGroupId: string,
    userId: string,
    interestLevel: EventInterestLevel
  ): Promise<WorkingGroupMembership | null> {
    const result = await query<WorkingGroupMembership>(
      `UPDATE working_group_memberships
       SET interest_level = $3, updated_at = NOW()
       WHERE working_group_id = $1 AND workos_user_id = $2
       RETURNING *`,
      [workingGroupId, userId, interestLevel]
    );

    return result.rows[0] || null;
  }

  /**
   * Get members of an event group with interest level stats
   */
  async getEventGroupAttendees(workingGroupId: string): Promise<{
    members: WorkingGroupMembership[];
    stats: {
      total: number;
      attending: number;
      interested: number;
      maybe: number;
    };
  }> {
    const members = await this.getMembershipsByWorkingGroup(workingGroupId);

    const stats = {
      total: members.length,
      attending: members.filter(m => m.interest_level === 'attending').length,
      interested: members.filter(m => m.interest_level === 'interested').length,
      maybe: members.filter(m => m.interest_level === 'maybe').length,
    };

    return { members, stats };
  }

  // ============== Committee Documents ==============

  /**
   * Create a new committee document
   */
  async createDocument(input: CreateCommitteeDocumentInput): Promise<CommitteeDocument> {
    // Detect document type from URL if not provided
    const documentType = input.document_type || this.detectDocumentType(input.document_url);

    const result = await query<CommitteeDocument>(
      `INSERT INTO committee_documents (
        working_group_id, title, description, document_url, document_type,
        display_order, is_featured, added_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        input.working_group_id,
        input.title,
        input.description || null,
        input.document_url,
        documentType,
        input.display_order ?? 0,
        input.is_featured ?? false,
        input.added_by_user_id || null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Detect document type from URL
   */
  private detectDocumentType(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'docs.google.com') {
        if (parsed.pathname.includes('/document/')) return 'google_doc';
        if (parsed.pathname.includes('/spreadsheets/')) return 'google_sheet';
      }
      if (parsed.hostname === 'drive.google.com') return 'google_doc';
      if (url.toLowerCase().endsWith('.pdf')) return 'pdf';
      return 'external_link';
    } catch {
      return 'external_link';
    }
  }

  /**
   * Get document by ID
   */
  async getDocumentById(id: string): Promise<CommitteeDocument | null> {
    const result = await query<CommitteeDocument>(
      'SELECT * FROM committee_documents WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all documents for a working group
   */
  async getDocumentsByWorkingGroup(workingGroupId: string): Promise<CommitteeDocument[]> {
    const result = await query<CommitteeDocument>(
      `SELECT * FROM committee_documents
       WHERE working_group_id = $1
       ORDER BY is_featured DESC, display_order ASC, created_at DESC`,
      [workingGroupId]
    );
    return result.rows;
  }

  /**
   * Get documents that need indexing (pending or due for refresh)
   */
  async getDocumentsPendingIndex(limit = 50): Promise<CommitteeDocument[]> {
    const result = await query<CommitteeDocument>(
      `SELECT cd.* FROM committee_documents cd
       JOIN working_groups wg ON wg.id = cd.working_group_id
       WHERE wg.status = 'active'
         AND cd.index_status IN ('pending', 'success')
         AND cd.document_type IN ('google_doc', 'google_sheet')
         AND (
           cd.last_indexed_at IS NULL
           OR cd.last_indexed_at < NOW() - INTERVAL '1 hour'
         )
       ORDER BY cd.last_indexed_at ASC NULLS FIRST
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Update document with new indexed content
   */
  async updateDocumentIndex(
    id: string,
    contentHash: string,
    content: string,
    status: DocumentIndexStatus,
    error?: string
  ): Promise<CommitteeDocument | null> {
    const result = await query<CommitteeDocument>(
      `UPDATE committee_documents
       SET content_hash = $2::varchar(64),
           last_content = $3,
           index_status = $4,
           index_error = $5,
           last_indexed_at = NOW(),
           last_modified_at = CASE
             WHEN content_hash IS DISTINCT FROM $2::varchar(64) THEN NOW()
             ELSE last_modified_at
           END
       WHERE id = $1
       RETURNING *`,
      [id, contentHash, content, status, error || null]
    );
    return result.rows[0] || null;
  }

  /**
   * Update document summary
   */
  async updateDocumentSummary(id: string, summary: string): Promise<CommitteeDocument | null> {
    const result = await query<CommitteeDocument>(
      `UPDATE committee_documents
       SET document_summary = $2, summary_generated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, summary]
    );
    return result.rows[0] || null;
  }

  /**
   * Update a document
   */
  async updateDocument(id: string, updates: UpdateCommitteeDocumentInput): Promise<CommitteeDocument | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    const fieldMap: Record<string, string> = {
      title: 'title',
      description: 'description',
      document_url: 'document_url',
      document_type: 'document_type',
      display_order: 'display_order',
      is_featured: 'is_featured',
    };

    for (const [key, value] of Object.entries(updates)) {
      const columnName = fieldMap[key];
      if (!columnName) continue;

      setClauses.push(`${columnName} = $${paramIndex}`);
      params.push(value ?? null);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return this.getDocumentById(id);
    }

    params.push(id);
    const result = await query<CommitteeDocument>(
      `UPDATE committee_documents SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );

    return result.rows[0] || null;
  }

  /**
   * Delete a document
   */
  async deleteDocument(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM committee_documents WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ============== Committee Summaries ==============

  /**
   * Create a new summary (marks previous of same type as superseded)
   */
  async createSummary(
    workingGroupId: string,
    summaryType: CommitteeSummaryType,
    summaryText: string,
    inputSources: Array<{ type: string; id: string; title: string }>,
    timePeriodStart?: Date,
    timePeriodEnd?: Date,
    generatedBy = 'addie'
  ): Promise<CommitteeSummary> {
    // Mark previous current summaries of this type as superseded
    await query(
      `UPDATE committee_summaries
       SET is_current = FALSE, superseded_at = NOW()
       WHERE working_group_id = $1
         AND summary_type = $2
         AND is_current = TRUE`,
      [workingGroupId, summaryType]
    );

    const result = await query<CommitteeSummary>(
      `INSERT INTO committee_summaries (
        working_group_id, summary_type, summary_text, input_sources,
        time_period_start, time_period_end, generated_by, is_current
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
      RETURNING *`,
      [
        workingGroupId,
        summaryType,
        summaryText,
        JSON.stringify(inputSources),
        timePeriodStart || null,
        timePeriodEnd || null,
        generatedBy,
      ]
    );

    // Update superseded_by on old summaries
    if (result.rows[0]) {
      await query(
        `UPDATE committee_summaries
         SET superseded_by = $1
         WHERE working_group_id = $2
           AND summary_type = $3
           AND is_current = FALSE
           AND superseded_by IS NULL`,
        [result.rows[0].id, workingGroupId, summaryType]
      );
    }

    return result.rows[0];
  }

  /**
   * Get current summary of a specific type
   */
  async getCurrentSummary(
    workingGroupId: string,
    summaryType: CommitteeSummaryType
  ): Promise<CommitteeSummary | null> {
    const result = await query<CommitteeSummary>(
      `SELECT * FROM committee_summaries
       WHERE working_group_id = $1
         AND summary_type = $2
         AND is_current = TRUE`,
      [workingGroupId, summaryType]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all current summaries for a working group
   */
  async getCurrentSummaries(workingGroupId: string): Promise<CommitteeSummary[]> {
    const result = await query<CommitteeSummary>(
      `SELECT * FROM committee_summaries
       WHERE working_group_id = $1 AND is_current = TRUE
       ORDER BY summary_type`,
      [workingGroupId]
    );
    return result.rows;
  }

  /**
   * Get working groups that need summary refresh
   */
  async getWorkingGroupsNeedingSummaryRefresh(limit = 20): Promise<string[]> {
    const result = await query<{ id: string }>(
      `SELECT wg.id
       FROM working_groups wg
       LEFT JOIN committee_summaries cs ON cs.working_group_id = wg.id
         AND cs.summary_type = 'activity'
         AND cs.is_current = TRUE
       WHERE wg.status = 'active'
         AND wg.committee_type != 'industry_gathering'
         AND (
           cs.id IS NULL
           OR cs.generated_at < NOW() - INTERVAL '24 hours'
         )
       ORDER BY cs.generated_at ASC NULLS FIRST
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(r => r.id);
  }

  // ============== Document Activity ==============

  /**
   * Log document activity
   */
  async logDocumentActivity(
    documentId: string,
    workingGroupId: string,
    activityType: DocumentActivityType,
    contentHashBefore?: string,
    contentHashAfter?: string,
    changeSummary?: string
  ): Promise<CommitteeDocumentActivity> {
    const result = await query<CommitteeDocumentActivity>(
      `INSERT INTO committee_document_activity (
        document_id, working_group_id, activity_type,
        content_hash_before, content_hash_after, change_summary
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        documentId,
        workingGroupId,
        activityType,
        contentHashBefore || null,
        contentHashAfter || null,
        changeSummary || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get recent activity for a working group
   */
  async getRecentActivity(workingGroupId: string, limit = 20): Promise<CommitteeDocumentActivity[]> {
    const result = await query<CommitteeDocumentActivity>(
      `SELECT cda.*, cd.title as document_title
       FROM committee_document_activity cda
       JOIN committee_documents cd ON cd.id = cda.document_id
       WHERE cda.working_group_id = $1
       ORDER BY cda.detected_at DESC
       LIMIT $2`,
      [workingGroupId, limit]
    );
    return result.rows;
  }
}
