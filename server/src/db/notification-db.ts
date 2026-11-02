import { query } from './client.js';
import { createLogger } from '../logger.js';
import { flattenToSingleLine } from '../utils/slack-escape.js';

const logger = createLogger('notification-db');

/**
 * Short-lived in-memory cache for unread counts.
 * Reduces DB pressure from the 30-second polling interval across many tabs/users.
 */
const countCache = new Map<string, { count: number; expiresAt: number }>();
const COUNT_CACHE_TTL_MS = 30_000; // Match the 30s client poll interval

/**
 * Caps for the two halves of a notification (adcp#8320). The title is one
 * line in a Slack DM and one line in the web notification list, so it stays
 * short. The body carries the detail a recipient needs to act — an agent's
 * error text, a run summary — and gets more room, but still a fixed ceiling,
 * because the party being reported on decides how long its message is.
 *
 * Enforced here rather than in `notifyUser` so the invariant holds for the
 * callers that write a notification row directly.
 */
export const NOTIFICATION_TITLE_MAX_LENGTH = 200;
export const NOTIFICATION_BODY_MAX_LENGTH = 500;

/**
 * Notification links are site-relative paths. The stored value is rendered
 * both as an HTML `href` and as the target of a Slack `<url|View>` link,
 * and neither can be escaped the way text can: `javascript:` would run on
 * click, `//evil.example` is a protocol-relative jump off-site, and a `>`
 * or `|` closes the Slack link early and leaves the remainder as top-level
 * mrkdwn. Anything that is not an unambiguous local path is dropped.
 *
 * Backslashes are rejected outright because the WHATWG URL parser folds
 * them to `/` for http(s) — so a browser reads `/\evil.example` as the
 * protocol-relative `//evil.example` that the second check exists to stop.
 */
export function isSafeNotificationPath(url: string): boolean {
  return url.startsWith('/')
    && !url.startsWith('//')
    // eslint-disable-next-line no-control-regex
    && !/[<>|\\\s\u0000-\u001f\u007f]/u.test(url);
}

export interface Notification {
  id: string;
  recipient_user_id: string;
  actor_user_id: string | null;
  type: string;
  reference_id: string | null;
  reference_type: string | null;
  title: string;
  /** Untrusted detail (agent error text, run summaries). Renderers must escape it. */
  body: string | null;
  url: string | null;
  is_read: boolean;
  created_at: string;
  // Joined from users table
  actor_first_name?: string;
  actor_last_name?: string;
  actor_avatar_url?: string;
}

export class NotificationDatabase {
  /**
   * Insert a notification row. `title` must be a fixed template plus
   * platform-controlled fields; anything an agent, a member, or a remote
   * service can influence belongs in `body`. Both are flattened to a single
   * line and truncated here, so no caller can store an unbounded or
   * multi-line value (adcp#8320).
   */
  async createNotification(data: {
    recipientUserId: string;
    actorUserId?: string;
    type: string;
    referenceId?: string;
    referenceType?: string;
    title: string;
    body?: string;
    url?: string;
  }): Promise<Notification> {
    const result = await query<Notification>(
      `INSERT INTO notifications (recipient_user_id, actor_user_id, type, reference_id, reference_type, title, body, url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.recipientUserId,
        data.actorUserId || null,
        data.type,
        data.referenceId || null,
        data.referenceType || null,
        flattenToSingleLine(data.title, NOTIFICATION_TITLE_MAX_LENGTH),
        data.body ? flattenToSingleLine(data.body, NOTIFICATION_BODY_MAX_LENGTH) : null,
        data.url && isSafeNotificationPath(data.url) ? data.url : null,
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
