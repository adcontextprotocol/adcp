/**
 * Marketing Opt-In DM
 *
 * Sends new Slack members a DM asking if they'd like to receive
 * email newsletters (The Prompt, The Build) and event notifications.
 *
 * Fires on team_join after the welcome social posts DM.
 */

import { createLogger } from '../logger.js';
import { sendDirectMessage } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';

const logger = createLogger('marketing-optin-dm');

export async function sendMarketingOptInDM(slackUserId: string): Promise<boolean> {
  const message: SlackBlockMessage = {
    text: 'Would you like to receive The Prompt, The Build, and event notifications via email?',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Would you like to receive our newsletters and event notifications via email?*\n\nWe publish _The Prompt_ (industry news) and _The Build_ (contributor updates), plus event invitations. You can manage preferences any time from your dashboard.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Yes, keep me updated', emoji: true },
            style: 'primary',
            action_id: 'marketing_optin_yes',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'No thanks', emoji: true },
            action_id: 'marketing_optin_no',
          },
        ],
      },
    ],
  };

  try {
    const result = await sendDirectMessage(slackUserId, message);
    if (result.ok) {
      logger.info({ slackUserId }, 'Marketing opt-in DM sent');
      return true;
    }
    logger.warn({ slackUserId, error: result.error }, 'Marketing opt-in DM failed');
    return false;
  } catch (err) {
    logger.error({ err, slackUserId }, 'Marketing opt-in DM error');
    return false;
  }
}
