/**
 * Admin Notification Channels routes module
 *
 * Admin-only routes for managing Slack notification channels:
 * - List channels with stats
 * - Create/update/delete channels
 * - Enable/disable channels
 * - Test message sending
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import {
  getAllChannels,
  getChannelById,
  createChannel,
  updateChannel,
  deleteChannel,
  setChannelActive,
  getChannelStats,
  type NotificationChannelInput,
} from '../../db/notification-channels-db.js';
import { sendChannelMessage } from '../../slack/client.js';
import type { FallbackRules } from '../../db/notification-channels-db.js';

const logger = createLogger('admin-notification-channels');

/**
 * Validate and sanitize fallback_rules to prevent arbitrary JSON injection
 */
function validateFallbackRules(rules: unknown): FallbackRules {
  if (!rules || typeof rules !== 'object') return {};
  const validated: FallbackRules = {};
  const r = rules as Record<string, unknown>;

  if (typeof r.min_quality === 'number' && r.min_quality >= 1 && r.min_quality <= 5) {
    validated.min_quality = r.min_quality;
  }
  if (Array.isArray(r.require_tags)) {
    validated.require_tags = r.require_tags.filter((t): t is string => typeof t === 'string').slice(0, 20);
  }
  if (typeof r.require_mentions_adcp === 'boolean') {
    validated.require_mentions_adcp = r.require_mentions_adcp;
  }
  if (typeof r.require_mentions_agentic === 'boolean') {
    validated.require_mentions_agentic = r.require_mentions_agentic;
  }
  return validated;
}

export function createAdminNotificationChannelsRouter(): Router {
  const router = Router();

  // GET /api/admin/notification-channels - List all channels with stats
  router.get('/', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const channels = await getAllChannels();
      const stats = await getChannelStats();
      res.json({ channels, stats });
    } catch (error) {
      logger.error({ err: error }, 'List notification channels error');
      res.status(500).json({
        error: 'Failed to list notification channels',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/notification-channels/:id - Get single channel
  router.get('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const channelId = parseInt(req.params.id, 10);
      if (isNaN(channelId)) {
        return res.status(400).json({ error: 'Invalid channel ID' });
      }

      const channel = await getChannelById(channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      res.json({ channel });
    } catch (error) {
      logger.error({ err: error }, 'Get notification channel error');
      res.status(500).json({
        error: 'Failed to get notification channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/notification-channels - Create new channel
  router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, slack_channel_id, description, fallback_rules } = req.body;

      if (!name || !slack_channel_id || !description) {
        return res.status(400).json({
          error: 'Name, slack_channel_id, and description are required',
        });
      }

      // Validate Slack channel ID format (should start with C or G)
      if (!/^[CG][A-Z0-9]+$/.test(slack_channel_id)) {
        return res.status(400).json({
          error: 'Invalid Slack channel ID format. Should start with C or G followed by alphanumeric characters.',
        });
      }

      const channelData: NotificationChannelInput = {
        name,
        slack_channel_id,
        description,
        fallback_rules: validateFallbackRules(fallback_rules),
      };

      const channel = await createChannel(channelData);
      logger.info({ channelId: channel.id, name, slack_channel_id }, 'Notification channel created');
      res.json({ channel });
    } catch (error) {
      logger.error({ err: error }, 'Create notification channel error');

      // Handle unique constraint violation
      if (error instanceof Error && error.message.includes('unique constraint')) {
        return res.status(400).json({
          error: 'A channel with this Slack channel ID already exists',
        });
      }

      res.status(500).json({
        error: 'Failed to create notification channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/admin/notification-channels/:id - Update channel
  router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const channelId = parseInt(req.params.id, 10);
      if (isNaN(channelId)) {
        return res.status(400).json({ error: 'Invalid channel ID' });
      }

      const { name, slack_channel_id, description, fallback_rules } = req.body;

      // Validate Slack channel ID format if provided
      if (slack_channel_id && !/^[CG][A-Z0-9]+$/.test(slack_channel_id)) {
        return res.status(400).json({
          error: 'Invalid Slack channel ID format. Should start with C or G followed by alphanumeric characters.',
        });
      }

      const channel = await updateChannel(channelId, {
        name,
        slack_channel_id,
        description,
        fallback_rules: fallback_rules !== undefined ? validateFallbackRules(fallback_rules) : undefined,
      });

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      logger.info({ channelId, updates: req.body }, 'Notification channel updated');
      res.json({ channel });
    } catch (error) {
      logger.error({ err: error }, 'Update notification channel error');

      if (error instanceof Error && error.message.includes('unique constraint')) {
        return res.status(400).json({
          error: 'A channel with this Slack channel ID already exists',
        });
      }

      res.status(500).json({
        error: 'Failed to update notification channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/notification-channels/:id/toggle - Enable/disable channel
  router.post('/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
    try {
      const channelId = parseInt(req.params.id, 10);
      if (isNaN(channelId)) {
        return res.status(400).json({ error: 'Invalid channel ID' });
      }

      const { is_active } = req.body;
      const updated = await setChannelActive(channelId, !!is_active);

      if (!updated) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      logger.info({ channelId, is_active }, 'Notification channel toggled');
      res.json({ success: true, is_active: !!is_active });
    } catch (error) {
      logger.error({ err: error }, 'Toggle notification channel error');
      res.status(500).json({
        error: 'Failed to toggle notification channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/admin/notification-channels/:id - Delete channel
  router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const channelId = parseInt(req.params.id, 10);
      if (isNaN(channelId)) {
        return res.status(400).json({ error: 'Invalid channel ID' });
      }

      const deleted = await deleteChannel(channelId);
      if (!deleted) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      logger.info({ channelId }, 'Notification channel deleted');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Delete notification channel error');
      res.status(500).json({
        error: 'Failed to delete notification channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/notification-channels/:id/test - Send test message
  router.post('/:id/test', requireAuth, requireAdmin, async (req, res) => {
    try {
      const channelId = parseInt(req.params.id, 10);
      if (isNaN(channelId)) {
        return res.status(400).json({ error: 'Invalid channel ID' });
      }

      const channel = await getChannelById(channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      // Send test message
      const result = await sendChannelMessage(channel.slack_channel_id, {
        text: `Test notification from AgenticAdvertising.org`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *Test Notification*\n\nThis is a test message from the AgenticAdvertising.org notification system.\n\n*Channel:* ${channel.name}\n*Purpose:* ${channel.description}`,
            },
          },
        ],
      });

      if (result.ok) {
        logger.info({ channelId, slackChannelId: channel.slack_channel_id }, 'Test message sent');
        res.json({ success: true, message: 'Test message sent successfully' });
      } else {
        logger.warn({ channelId, error: result.error }, 'Test message failed');
        res.status(400).json({
          error: 'Failed to send test message',
          message: result.error || 'Unknown Slack error',
        });
      }
    } catch (error) {
      logger.error({ err: error }, 'Test notification channel error');
      res.status(500).json({
        error: 'Failed to send test message',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
