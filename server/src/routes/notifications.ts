import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { NotificationDatabase } from '../db/notification-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('notification-routes');

export function createNotificationRouter() {
  const router = Router();
  const notificationDb = new NotificationDatabase();

  // GET /api/notifications — list notifications for current user
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 50);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      const unreadOnly = req.query.unread_only === 'true';

      const result = await notificationDb.listNotifications(user.id, { limit, offset, unreadOnly });
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'List notifications error');
      res.status(500).json({ error: 'Failed to list notifications' });
    }
  });

  // GET /api/notifications/count — unread count for bell badge
  router.get('/count', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const count = await notificationDb.getUnreadCount(user.id);
      res.json({ count });
    } catch (error) {
      logger.error({ err: error }, 'Get notification count error');
      res.status(500).json({ error: 'Failed to get count' });
    }
  });

  // POST /api/notifications/:id/read — mark one notification as read
  router.post('/:id/read', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid notification ID' });
      }
      const success = await notificationDb.markAsRead(req.params.id, user.id);
      res.json({ success });
    } catch (error) {
      logger.error({ err: error }, 'Mark notification read error');
      res.status(500).json({ error: 'Failed to mark as read' });
    }
  });

  // POST /api/notifications/read-all — mark all notifications as read
  router.post('/read-all', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const count = await notificationDb.markAllAsRead(user.id);
      res.json({ marked: count });
    } catch (error) {
      logger.error({ err: error }, 'Mark all read error');
      res.status(500).json({ error: 'Failed to mark all as read' });
    }
  });

  return router;
}
