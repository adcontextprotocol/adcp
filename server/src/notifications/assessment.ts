/**
 * Assessment notification service
 *
 * Posts persona assessment completions to the configured admin Slack channel.
 */

import { createLogger } from '../logger.js';
import { getAdminChannel } from '../db/system-settings-db.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import type { SlackBlock, SlackTextObject } from '../slack/types.js';

const logger = createLogger('assessment-notifications');

const PERSONA_LABELS: Record<string, string> = {
  molecule_builder: 'Molecular Gastronomist',
  data_decoder: 'Data Denizen',
  pureblood_protector: 'Mold Breaker',
  resops_integrator: 'RevOps Integrator',
  ladder_climber: 'Positionless Marketer',
  simple_starter: 'Simple Simon',
};

/**
 * Post assessment completion to the admin channel
 */
export async function notifyAssessmentCompleted(data: {
  organizationName: string;
  userName: string;
  userEmail: string;
  persona: string;
}): Promise<boolean> {
  if (!isSlackConfigured()) {
    logger.debug('Slack not configured, skipping assessment notification');
    return false;
  }

  const adminChannel = await getAdminChannel();
  if (!adminChannel.channel_id) {
    logger.debug('Admin channel not configured, skipping assessment notification');
    return false;
  }

  const personaLabel = PERSONA_LABELS[data.persona] || data.persona;
  const text = `Assessment completed: ${data.organizationName} → ${personaLabel}`;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Persona assessment completed', emoji: true } as SlackTextObject,
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Organization:*\n${data.organizationName}` },
        { type: 'mrkdwn', text: `*Persona:*\n${personaLabel}` },
        { type: 'mrkdwn', text: `*Submitted by:*\n${data.userName}` },
        { type: 'mrkdwn', text: `*Email:*\n${data.userEmail}` },
      ],
    },
  ];

  try {
    const result = await sendChannelMessage(adminChannel.channel_id, { text, blocks });
    if (result.ok) {
      logger.info({ channel: adminChannel.channel_name, org: data.organizationName }, 'Assessment notification sent');
      return true;
    } else {
      logger.warn({ error: result.error, channel: adminChannel.channel_id }, 'Failed to send assessment notification');
      return false;
    }
  } catch (error) {
    logger.error({ error, channel: adminChannel.channel_id }, 'Error sending assessment notification');
    return false;
  }
}
