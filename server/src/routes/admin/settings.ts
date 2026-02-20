/**
 * Admin System Settings routes module
 *
 * Admin-only routes for managing system-wide configuration:
 * - View/update billing notification channel
 * - List available Slack channels for picker
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import {
  getAllSettings,
  getBillingChannel,
  setBillingChannel,
  getEscalationChannel,
  setEscalationChannel,
  getAdminChannel,
  setAdminChannel,
} from '../../db/system-settings-db.js';
import { getSlackChannels, getChannelInfo, isSlackConfigured } from '../../slack/client.js';

const logger = createLogger('admin-settings');

export function createAdminSettingsRouter(): Router {
  const router = Router();

  // GET /api/admin/settings - Get all system settings
  router.get('/', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const settings = await getAllSettings();
      const billingChannel = await getBillingChannel();
      const escalationChannel = await getEscalationChannel();
      const adminChannel = await getAdminChannel();

      res.json({
        settings,
        billing_channel: billingChannel,
        escalation_channel: escalationChannel,
        admin_channel: adminChannel,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get system settings');
      res.status(500).json({
        error: 'Failed to get system settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/settings/slack-channels - List available Slack channels for picker
  router.get('/slack-channels', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      if (!isSlackConfigured()) {
        res.status(400).json({
          error: 'Slack not configured',
          message: 'ADDIE_BOT_TOKEN is not set',
        });
        return;
      }

      // Only private channels - billing info should not go to public channels
      const channels = await getSlackChannels({
        types: 'private_channel',
        exclude_archived: true,
      });

      // Sort by name and return minimal info
      const sorted = channels
        .map(c => ({
          id: c.id,
          name: c.name,
          is_private: c.is_private,
          num_members: c.num_members,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({ channels: sorted });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list Slack channels');
      res.status(500).json({
        error: 'Failed to list Slack channels',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/admin/settings/billing-channel - Update billing notification channel
  router.put('/billing-channel', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { channel_id, channel_name } = req.body;

      // Allow null to clear the channel
      if (channel_id !== null && channel_id !== undefined) {
        // Validate channel ID format
        if (typeof channel_id !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel_id)) {
          res.status(400).json({
            error: 'Invalid channel ID format',
            message: 'Channel ID should start with C or G followed by alphanumeric characters',
          });
          return;
        }

        // Verify the channel is private (billing info should not go to public channels)
        if (isSlackConfigured()) {
          const channelInfo = await getChannelInfo(channel_id);
          if (channelInfo && !channelInfo.is_private) {
            res.status(400).json({
              error: 'Invalid channel',
              message: 'Only private channels are allowed for billing notifications',
            });
            return;
          }
        }
      }

      // Validate channel name if provided
      if (channel_name !== null && channel_name !== undefined) {
        if (typeof channel_name !== 'string' || channel_name.length > 200) {
          res.status(400).json({
            error: 'Invalid channel name',
            message: 'Channel name must be a string under 200 characters',
          });
          return;
        }
      }

      const userId = req.user?.id;
      await setBillingChannel(channel_id ?? null, channel_name ?? null, userId);

      logger.info({ channel_id, channel_name, userId }, 'Billing channel updated');

      const updated = await getBillingChannel();
      res.json({
        success: true,
        billing_channel: updated,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update billing channel');
      res.status(500).json({
        error: 'Failed to update billing channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/admin/settings/escalation-channel - Update escalation notification channel
  router.put('/escalation-channel', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { channel_id, channel_name } = req.body;

      // Allow null to clear the channel
      if (channel_id !== null && channel_id !== undefined) {
        // Validate channel ID format
        if (typeof channel_id !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel_id)) {
          res.status(400).json({
            error: 'Invalid channel ID format',
            message: 'Channel ID should start with C or G followed by alphanumeric characters',
          });
          return;
        }

        // Verify the channel is private (escalation info may contain sensitive user data)
        if (isSlackConfigured()) {
          const channelInfo = await getChannelInfo(channel_id);
          if (channelInfo && !channelInfo.is_private) {
            res.status(400).json({
              error: 'Invalid channel',
              message: 'Only private channels are allowed for escalation notifications',
            });
            return;
          }
        }
      }

      // Validate channel name if provided
      if (channel_name !== null && channel_name !== undefined) {
        if (typeof channel_name !== 'string' || channel_name.length > 200) {
          res.status(400).json({
            error: 'Invalid channel name',
            message: 'Channel name must be a string under 200 characters',
          });
          return;
        }
      }

      const userId = req.user?.id;
      await setEscalationChannel(channel_id ?? null, channel_name ?? null, userId);

      logger.info({ channel_id, channel_name, userId }, 'Escalation channel updated');

      const updated = await getEscalationChannel();
      res.json({
        success: true,
        escalation_channel: updated,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update escalation channel');
      res.status(500).json({
        error: 'Failed to update escalation channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/admin/settings/admin-channel - Update admin notification channel
  router.put('/admin-channel', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { channel_id, channel_name } = req.body;

      if (channel_id !== null && channel_id !== undefined) {
        if (typeof channel_id !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel_id)) {
          res.status(400).json({
            error: 'Invalid channel ID format',
            message: 'Channel ID should start with C or G followed by alphanumeric characters',
          });
          return;
        }

        if (isSlackConfigured()) {
          const channelInfo = await getChannelInfo(channel_id);
          if (channelInfo && !channelInfo.is_private) {
            res.status(400).json({
              error: 'Invalid channel',
              message: 'Only private channels are allowed for admin notifications',
            });
            return;
          }
        }
      }

      if (channel_name !== null && channel_name !== undefined) {
        if (typeof channel_name !== 'string' || channel_name.length > 200) {
          res.status(400).json({
            error: 'Invalid channel name',
            message: 'Channel name must be a string under 200 characters',
          });
          return;
        }
      }

      const userId = req.user?.id;
      await setAdminChannel(channel_id ?? null, channel_name ?? null, userId);

      logger.info({ channel_id, channel_name, userId }, 'Admin channel updated');

      const updated = await getAdminChannel();
      res.json({ success: true, admin_channel: updated });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update admin channel');
      res.status(500).json({
        error: 'Failed to update admin channel',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
