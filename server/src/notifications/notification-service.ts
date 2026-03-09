import { NotificationDatabase } from '../db/notification-db.js';
import { SlackDatabase } from '../db/slack-db.js';
import { sendDirectMessage } from '../slack/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('notification-service');
const notificationDb = new NotificationDatabase();
const slackDb = new SlackDatabase();

/**
 * Create an in-app notification and optionally send a Slack DM.
 * Fire-and-forget safe — errors are logged but never thrown.
 */
export async function notifyUser(data: {
  recipientUserId: string;
  actorUserId?: string;
  type: string;
  referenceId?: string;
  referenceType?: string;
  title: string;
  url?: string;
}): Promise<void> {
  try {
    // Don't notify users about their own actions
    if (data.actorUserId && data.recipientUserId === data.actorUserId) {
      return;
    }

    await notificationDb.createNotification(data);

    // Send Slack DM if user has a linked Slack account
    const slackMapping = await slackDb.getByWorkosUserId(data.recipientUserId);
    if (slackMapping?.slack_user_id) {
      const baseUrl = process.env.BASE_URL || 'https://agenticadvertising.org';
      const fullUrl = data.url ? `${baseUrl}${data.url}` : undefined;
      const text = fullUrl ? `${data.title}\n<${fullUrl}|View>` : data.title;

      await sendDirectMessage(slackMapping.slack_user_id, { text });
    }
  } catch (error) {
    logger.error({ err: error, data }, 'Failed to send notification');
  }
}
