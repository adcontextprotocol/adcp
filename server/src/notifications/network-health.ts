/**
 * Slack notifications for network health alerts.
 *
 * Sends grouped alerts per authoritative URL (not per-domain spam).
 * Supports both org-configured webhooks and the platform Slack channel.
 */

import { createLogger } from '../logger.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';
import type { CreateAlertInput, NetworkAlertRule } from '../db/network-health-db.js';

const logger = createLogger('network-health-notifications');

const CHANNEL_ID = process.env.NETWORK_HEALTH_CHANNEL_ID;
const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\//;

function getPlatformChannelId(): string | null {
  if (!CHANNEL_ID) {
    logger.debug('NETWORK_HEALTH_CHANNEL_ID not configured, skipping platform notification');
    return null;
  }
  return CHANNEL_ID;
}

/**
 * Send grouped alerts to the operator's configured Slack webhook.
 * Validates the URL is a legitimate Slack webhook before sending.
 */
async function sendWebhookAlerts(
  webhookUrl: string,
  orgId: string,
  alerts: CreateAlertInput[]
): Promise<boolean> {
  if (!SLACK_WEBHOOK_PATTERN.test(webhookUrl)) {
    logger.warn({ orgId }, 'Refusing to send to non-Slack webhook URL');
    return false;
  }

  const criticalAlerts = alerts.filter((a) => a.severity === 'critical');
  const warningAlerts = alerts.filter((a) => a.severity === 'warning');

  const lines: string[] = [];
  if (criticalAlerts.length > 0) {
    lines.push(`*Critical (${criticalAlerts.length}):*`);
    for (const a of criticalAlerts) {
      lines.push(`  - ${a.summary}`);
    }
  }
  if (warningAlerts.length > 0) {
    lines.push(`*Warning (${warningAlerts.length}):*`);
    for (const a of warningAlerts) {
      lines.push(`  - ${a.summary}`);
    }
  }

  const payload = {
    text: `Network health alert: ${orgId}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Network Health Alert*\n\`${orgId}\``,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: lines.join('\n'),
        },
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, orgId }, 'Webhook delivery failed');
      return false;
    }
    return true;
  } catch (error) {
    logger.error({ error, orgId }, 'Error sending webhook alert');
    return false;
  }
}

/**
 * Send grouped alerts to the platform Slack channel.
 * Returns true if the message was sent successfully.
 */
async function sendPlatformChannelAlerts(
  orgId: string,
  alerts: CreateAlertInput[]
): Promise<boolean> {
  const channelId = getPlatformChannelId();
  if (!channelId || !isSlackConfigured()) return false;

  const hasCritical = alerts.some((a) => a.severity === 'critical');
  const emoji = hasCritical ? '🚨' : '⚠️';

  const summaryLines = alerts.map(
    (a) => `${a.severity === 'critical' ? '🔴' : '🟡'} ${a.summary}`
  );

  const message: SlackBlockMessage = {
    text: `${emoji} Network alert: ${orgId} (${alerts.length} issue${alerts.length === 1 ? '' : 's'})`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *Network Health Alert*\n\`${orgId}\``,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: summaryLines.join('\n'),
        },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
    return true;
  } catch (error) {
    logger.error({ error, orgId }, 'Failed to send platform channel alert');
    return false;
  }
}

/**
 * Dispatch all alerts for a given authoritative URL.
 * Sends to the operator's webhook (if configured) and to the platform channel.
 * Returns the list of channels that were notified successfully.
 */
export async function dispatchNetworkAlerts(
  orgId: string,
  alerts: CreateAlertInput[],
  rule: NetworkAlertRule | null
): Promise<string[]> {
  if (alerts.length === 0) return [];

  const notifiedVia: string[] = [];

  // Operator webhook
  if (rule?.slack_webhook_url) {
    const sent = await sendWebhookAlerts(rule.slack_webhook_url, orgId, alerts);
    if (sent) notifiedVia.push('slack');
  }

  // Platform channel
  const platformSent = await sendPlatformChannelAlerts(orgId, alerts);
  if (platformSent) notifiedVia.push('platform_slack');

  return notifiedVia;
}
