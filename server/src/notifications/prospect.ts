/**
 * Prospect notification service
 *
 * Posts new prospect alerts to the configured prospect Slack channel.
 * Differentiates between Addie-owned (informational) and human-needed (actionable).
 */

import { createLogger } from '../logger.js';
import { getProspectChannel } from '../db/system-settings-db.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import type { SlackBlock, SlackTextObject } from '../slack/types.js';
import { getCompanyTypeLabel } from '../config/company-types.js';

const logger = createLogger('prospect-notifications');

export async function notifyNewProspect(data: {
  orgName: string;
  domain: string;
  owner: 'addie' | 'human';
  priority?: 'high' | 'standard';
  verdict: string;
  companyType?: string;
  source: string;
  orgId?: string;
}): Promise<boolean> {
  if (!isSlackConfigured()) {
    logger.debug('Slack not configured, skipping prospect notification');
    return false;
  }

  const channel = await getProspectChannel();
  if (!channel.channel_id) {
    logger.debug('Prospect channel not configured, skipping notification');
    return false;
  }

  const typeLabel = data.companyType ? getCompanyTypeLabel(data.companyType) : 'Unknown';
  const sourceLabel = data.source === 'slack' ? 'Slack join' : data.source === 'inbound' ? 'Website signup' : data.source;
  const priorityLabel = data.priority === 'high' ? 'High priority' : 'Standard';

  const isHumanNeeded = data.owner === 'human';
  const headerText = isHumanNeeded
    ? 'Enterprise prospect needs an owner'
    : 'New prospect auto-triaged';
  const ownerLabel = isHumanNeeded
    ? 'Needs a human owner'
    : `Addie (auto-claimed${data.priority === 'high' ? ', high priority' : ''})`;

  const text = isHumanNeeded
    ? `Enterprise prospect needs an owner: ${data.orgName} (${data.domain})`
    : `New prospect: ${data.orgName} (${data.domain})`;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText, emoji: true } as SlackTextObject,
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Company:*\n${data.orgName}` },
        { type: 'mrkdwn', text: `*Domain:*\n${data.domain}` },
        { type: 'mrkdwn', text: `*Type:*\n${typeLabel}` },
        { type: 'mrkdwn', text: `*Source:*\n${sourceLabel}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Owner:*\n${ownerLabel}` },
        { type: 'mrkdwn', text: `*Priority:*\n${priorityLabel}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Assessment:*\n${data.verdict}` },
    },
  ];

  // Add action buttons for human-needed prospects
  if (isHumanNeeded && data.orgId) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Claim this prospect', emoji: true },
          style: 'primary',
          action_id: 'prospect_claim',
          value: data.orgId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not relevant', emoji: true },
          action_id: 'prospect_disqualify',
          value: data.orgId,
        },
      ],
    } as SlackBlock);
  }

  try {
    const result = await sendChannelMessage(channel.channel_id, { text, blocks });
    if (result.ok) {
      logger.info({ channel: channel.channel_name, org: data.orgName }, 'Prospect notification sent');
      return true;
    } else {
      logger.warn({ error: result.error, channel: channel.channel_id }, 'Failed to send prospect notification');
      return false;
    }
  } catch (error) {
    logger.error({ error, channel: channel.channel_id }, 'Error sending prospect notification');
    return false;
  }
}
