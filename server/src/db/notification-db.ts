import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('notification-db');

/**
 * Short-lived in-memory cache for unread counts.
 * Reduces DB pressure from the 30-second polling interval across many tabs/users.
 */
const countCache = new Map<string, { count: number; expiresAt: number }>();
const COUNT_CACHE_TTL_MS = 10_000; // 10 seconds

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
    this.invalidateCountCache(data.recipientUserId);
    return result.rows[0];
  }

  async getUnreadCount(userId: string): Promise<number> {
    const cached = countCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.count;
    }

    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM notifications WHERE recipient_user_id = $1 AND is_read = false`,
      [userId]
    );
    const count = parseInt(result.rows[0].count, 10);
    countCache.set(userId, { count, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
    return count;
  }

  /** Invalidate cached unread count for a user (call after read/create operations). */
  invalidateCountCache(userId: string): void {
    countCache.delete(userId);
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

    // Single query with window function — avoids a second DB round-trip for the count
    params.push(limit, offset);
    const result = await query<Notification & { _total: string }>(
      `SELECT n.*,
              u.first_name as actor_first_name,
              u.last_name as actor_last_name,
              u.avatar_url as actor_avatar_url,
              COUNT(*) OVER() AS _total
       FROM notifications n
       LEFT JOIN users u ON n.actor_user_id = u.workos_user_id
       WHERE ${whereClause}
       ORDER BY n.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params
    );

    const total = result.rows.length > 0 ? parseInt(result.rows[0]._total, 10) : 0;

    // Strip the _total column from returned rows
    const notifications = result.rows.map(({ _total, ...rest }) => rest as unknown as Notification);

    return { notifications, total };
  }

  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    const result = await query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND recipient_user_id = $2 AND is_read = false`,
      [notificationId, userId]
    );
    const updated = (result.rowCount ?? 0) > 0;
    if (updated) this.invalidateCountCache(userId);
    return updated;
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await query(
      `UPDATE notifications SET is_read = true WHERE recipient_user_id = $1 AND is_read = false`,
      [userId]
    );
    const count = result.rowCount ?? 0;
    if (count > 0) this.invalidateCountCache(userId);
    return count;
  }

  async exists(userId: string, type: string, referenceId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM notifications WHERE recipient_user_id = $1 AND type = $2 AND reference_id = $3 LIMIT 1`,
      [userId, type, referenceId]
    );
    return result.rows.length > 0;
  }
}
