import { query, getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('join-request-db');

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface JoinRequest {
  id: string;
  workos_user_id: string;
  user_email: string;
  workos_organization_id: string;
  status: JoinRequestStatus;
  handled_by_user_id: string | null;
  handled_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateJoinRequestInput {
  workos_user_id: string;
  user_email: string;
  workos_organization_id: string;
}

/**
 * Database operations for organization join requests
 */
export class JoinRequestDatabase {
  /**
   * Create a new join request
   */
  async createRequest(input: CreateJoinRequestInput): Promise<JoinRequest> {
    const result = await query<JoinRequest>(
      `INSERT INTO organization_join_requests (workos_user_id, user_email, workos_organization_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workos_user_id, workos_organization_id, status)
       WHERE status = 'pending'
       DO NOTHING
       RETURNING *`,
      [input.workos_user_id, input.user_email, input.workos_organization_id]
    );

    // If no row was returned, the request already exists
    if (result.rows.length === 0) {
      const existing = await this.getPendingRequest(input.workos_user_id, input.workos_organization_id);
      if (existing) {
        return existing;
      }
      throw new Error('Failed to create join request');
    }

    logger.info({
      requestId: result.rows[0].id,
      userId: input.workos_user_id,
      orgId: input.workos_organization_id
    }, 'Join request created');

    return result.rows[0];
  }

  /**
   * Get a join request by ID
   */
  async getRequest(id: string): Promise<JoinRequest | null> {
    const result = await query<JoinRequest>(
      'SELECT * FROM organization_join_requests WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get pending request for a user and organization
   */
  async getPendingRequest(workos_user_id: string, workos_organization_id: string): Promise<JoinRequest | null> {
    const result = await query<JoinRequest>(
      `SELECT * FROM organization_join_requests
       WHERE workos_user_id = $1 AND workos_organization_id = $2 AND status = 'pending'`,
      [workos_user_id, workos_organization_id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all pending requests for a user
   */
  async getUserPendingRequests(workos_user_id: string): Promise<JoinRequest[]> {
    const result = await query<JoinRequest>(
      `SELECT * FROM organization_join_requests
       WHERE workos_user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [workos_user_id]
    );
    return result.rows;
  }

  /**
   * Get all pending requests for an organization (for admins)
   */
  async getOrganizationPendingRequests(workos_organization_id: string): Promise<JoinRequest[]> {
    const result = await query<JoinRequest>(
      `SELECT * FROM organization_join_requests
       WHERE workos_organization_id = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [workos_organization_id]
    );
    return result.rows;
  }

  /**
   * Approve a join request
   */
  async approveRequest(id: string, handled_by_user_id: string): Promise<JoinRequest | null> {
    const result = await query<JoinRequest>(
      `UPDATE organization_join_requests
       SET status = 'approved', handled_by_user_id = $2, handled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, handled_by_user_id]
    );

    if (result.rows[0]) {
      logger.info({
        requestId: id,
        handledBy: handled_by_user_id
      }, 'Join request approved');
    }

    return result.rows[0] || null;
  }

  /**
   * Reject a join request
   */
  async rejectRequest(id: string, handled_by_user_id: string, reason?: string): Promise<JoinRequest | null> {
    const result = await query<JoinRequest>(
      `UPDATE organization_join_requests
       SET status = 'rejected', handled_by_user_id = $2, handled_at = NOW(), rejection_reason = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, handled_by_user_id, reason || null]
    );

    if (result.rows[0]) {
      logger.info({
        requestId: id,
        handledBy: handled_by_user_id,
        reason
      }, 'Join request rejected');
    }

    return result.rows[0] || null;
  }

  /**
   * Cancel a join request (by the user who made it)
   */
  async cancelRequest(id: string, workos_user_id: string): Promise<JoinRequest | null> {
    const result = await query<JoinRequest>(
      `UPDATE organization_join_requests
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND workos_user_id = $2 AND status = 'pending'
       RETURNING *`,
      [id, workos_user_id]
    );

    if (result.rows[0]) {
      logger.info({ requestId: id, userId: workos_user_id }, 'Join request cancelled');
    }

    return result.rows[0] || null;
  }

  /**
   * Check if user has a pending request for an organization
   */
  async hasPendingRequest(workos_user_id: string, workos_organization_id: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM organization_join_requests
       WHERE workos_user_id = $1 AND workos_organization_id = $2 AND status = 'pending'
       LIMIT 1`,
      [workos_user_id, workos_organization_id]
    );
    return result.rows.length > 0;
  }

  /**
   * Get count of pending requests for an organization
   */
  async getPendingRequestCount(workos_organization_id: string): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM organization_join_requests
       WHERE workos_organization_id = $1 AND status = 'pending'`,
      [workos_organization_id]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }
}
