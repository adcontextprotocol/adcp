import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('notification-db');

export interface Notification {
  id: string;
  recipient_user_id: string;
  actor_user_id: string | null;
  type: string;
  reference_id: string | null;
  reference_type: string | null;
  title: string;
  url: string | null;
  is_read: boolean;
  created_at: string;
  // Joined from users table
  actor_first_name?: string;
  actor_last_name?: string;
  actor_avatar_url?: string;
}

export class NotificationDatabase {
  async createNotification(data: {
    recipientUserId: string;
    actorUserId?: string;
    type: string;
    referenceId?: string;
    referenceType?: string;
    title: string;
    url?: string;
  }): Promise<Notification> {
    const result = await query<Notification>(
      `INSERT INTO notifications (recipient_user_id, actor_user_id, type, reference_id, reference_type, title, url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.recipientUserId,
        data.actorUserId || null,
        data.type,
        data.referenceId || null,
        data.referenceType || null,
        data.title,
        data.url || null,
      ]
    );
    return result.rows[0];
  }

  async getUnreadCount(userId: string): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM notifications WHERE recipient_user_id = $1 AND is_read = false`,
      [userId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  async listNotifications(
    userId: string,
    options: { limit?: number; offset?: number; unreadOnly?: boolean } = {}
  ): Promise<{ notifications: Notification[]; total: number }> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const conditions = ['n.recipient_user_id = $1'];
    const params: unknown[] = [userId];
    let paramIndex = 2;

    if (options.unreadOnly) {
      conditions.push('n.is_read = false');
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM notifications n WHERE ${whereClause}`,
      params.slice(0, paramIndex - 1)
    );

    params.push(limit, offset);
    const result = await query<Notification>(
      `SELECT n.*,
              u.first_name as actor_first_name,
              u.last_name as actor_last_name,
              u.avatar_url as actor_avatar_url
       FROM notifications n
       LEFT JOIN users u ON n.actor_user_id = u.workos_user_id
       WHERE ${whereClause}
       ORDER BY n.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params
    );

    return {
      notifications: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    const result = await query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND recipient_user_id = $2 AND is_read = false`,
      [notificationId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await query(
      `UPDATE notifications SET is_read = true WHERE recipient_user_id = $1 AND is_read = false`,
      [userId]
    );
    return result.rowCount ?? 0;
  }
}
