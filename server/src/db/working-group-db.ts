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
        is_private, status, display_order
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      description: 'description',
      slack_channel_url: 'slack_channel_url',
      slack_channel_id: 'slack_channel_id',
      is_private: 'is_private',
      status: 'status',
      display_order: 'display_order',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      // Handle leaders separately
      if (key === 'leader_user_ids') continue;

      const columnName = COLUMN_MAP[key];
      if (!columnName) {
        continue;
      }
      setClauses.push(`${columnName} = $${paramIndex++}`);
      params.push(value);
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
  async listWorkingGroupsForUser(userId: string): Promise<WorkingGroupWithMemberCount[]> {
    const result = await query<WorkingGroupWithMemberCount>(
      `SELECT wg.*, COUNT(wgm2.id)::int AS member_count
       FROM working_groups wg
       LEFT JOIN working_group_memberships wgm2 ON wg.id = wgm2.working_group_id AND wgm2.status = 'active'
       WHERE wg.status = 'active'
         AND (wg.is_private = false OR EXISTS (
           SELECT 1 FROM working_group_memberships wgm
           WHERE wgm.working_group_id = wg.id
             AND wgm.workos_user_id = $1
             AND wgm.status = 'active'
         ))
       GROUP BY wg.id
       ORDER BY wg.display_order, wg.name`,
      [userId]
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
        input.workos_user_id,
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
    const result = await query(
      `UPDATE working_group_memberships
       SET status = 'inactive', updated_at = NOW()
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [workingGroupId, userId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Hard delete a membership record
   */
  async deleteMembership(workingGroupId: string, userId: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM working_group_memberships
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [workingGroupId, userId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Get a specific membership
   */
  async getMembership(workingGroupId: string, userId: string): Promise<WorkingGroupMembership | null> {
    const result = await query<WorkingGroupMembership>(
      `SELECT * FROM working_group_memberships
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [workingGroupId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if user is a member of a working group
   */
  async isMember(workingGroupId: string, userId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM working_group_memberships
       WHERE working_group_id = $1 AND workos_user_id = $2 AND status = 'active'
       LIMIT 1`,
      [workingGroupId, userId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get all memberships for a working group
   */
  async getMembershipsByWorkingGroup(workingGroupId: string): Promise<WorkingGroupMembership[]> {
    const result = await query<WorkingGroupMembership>(
      `SELECT * FROM working_group_memberships
       WHERE working_group_id = $1 AND status = 'active'
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
    // Get leaders with user details from working_group_memberships (where user info is stored)
    const result = await query<WorkingGroupLeader>(
      `SELECT
         wgl.user_id,
         wgm.user_name AS name,
         wgm.user_org_name AS org_name,
         wgl.created_at
       FROM working_group_leaders wgl
       LEFT JOIN working_group_memberships wgm ON wgl.user_id = wgm.workos_user_id AND wgm.working_group_id = wgl.working_group_id
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

    const result = await query<WorkingGroupLeader & { working_group_id: string }>(
      `SELECT
         wgl.working_group_id,
         wgl.user_id,
         wgm.user_name AS name,
         wgm.user_org_name AS org_name,
         wgl.created_at
       FROM working_group_leaders wgl
       LEFT JOIN working_group_memberships wgm ON wgl.user_id = wgm.workos_user_id AND wgm.working_group_id = wgl.working_group_id
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
    // Remove existing leaders
    await query(
      'DELETE FROM working_group_leaders WHERE working_group_id = $1',
      [workingGroupId]
    );

    // Add new leaders in a single bulk insert
    if (userIds.length > 0) {
      const values = userIds.map((_, i) => `($1, $${i + 2})`).join(', ');
      await query(
        `INSERT INTO working_group_leaders (working_group_id, user_id)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [workingGroupId, ...userIds]
      );
    }

    // Ensure leaders are members
    await this.ensureLeadersAreMembers(workingGroupId);
  }

  /**
   * Add a leader to a working group
   */
  async addLeader(workingGroupId: string, userId: string): Promise<void> {
    await query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [workingGroupId, userId]
    );

    // Ensure leader is a member
    await this.ensureLeadersAreMembers(workingGroupId);
  }

  /**
   * Remove a leader from a working group
   */
  async removeLeader(workingGroupId: string, userId: string): Promise<void> {
    await query(
      'DELETE FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [workingGroupId, userId]
    );
  }

  /**
   * Check if a user is a leader of a working group
   */
  async isLeader(workingGroupId: string, userId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM working_group_leaders
       WHERE working_group_id = $1 AND user_id = $2
       LIMIT 1`,
      [workingGroupId, userId]
    );
    return result.rows.length > 0;
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
}
