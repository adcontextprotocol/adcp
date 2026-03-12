/**
 * Welcome Social Posts
 *
 * Sends new Slack members a DM with 3 evergreen social posts they can
 * share to announce they joined AgenticAdvertising.org.
 *
 * Fires on team_join. Separate from the conversational onboarding flow.
 * Respects bots and opt-outs.
 */

import { createLogger } from '../logger.js';
import { sendDirectMessage } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';

const logger = createLogger('welcome-social-posts');

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Send welcome social posts DM to a new Slack member.
 * Returns true if sent, false if skipped or failed.
 */
export async function sendWelcomeSocialPosts(data: {
  slackUserId: string;
  displayName?: string;
  isBot: boolean;
}): Promise<boolean> {
  if (data.isBot) {
    return false;
  }

  const linkedinA = `Most ad tech standards get written by the biggest players and handed down. AdCP is different -- it's built by practitioners, for practitioners, through an open member organization.

I just joined AgenticAdvertising.org because I think the way agents buy and sell media needs a shared language that no single company controls.

If you've ever lost a week to integration debugging between platforms, this is worth a look.

${BASE_URL}

#AdCP #AgenticAdvertising`;

  const linkedinB = `Every major ad platform is shipping AI agents. None of them talk to each other.

We're about to repeat the same interoperability mess we've been fighting for the last decade -- unless there's a protocol layer underneath. That's what AdCP is building: an open standard so agents from different platforms can actually transact.

Just joined the organization building it.

${BASE_URL}

#AdCP #AdTech`;

  const linkedinC = `I've spent enough hours manually translating campaign specs between platforms. The fact that AI agents are about to do the same thing -- just faster and at scale -- is not an improvement.

AdCP is an open protocol that gives agents a common language for media buying. I joined AgenticAdvertising.org to help build that standard.

${BASE_URL}

#AgenticAdvertising #Programmatic`;

  const twitter = `Just joined AgenticAdvertising.org -- ad tech practitioners building an open protocol so AI agents can actually transact across platforms. About time. ${BASE_URL} #AdCP`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Welcome${data.displayName ? `, ${escapeSlackMrkdwn(data.displayName)}` : ''}! If you'd like to share the news, here are a few ready-to-post options. Pick whichever sounds most like you, or use them as a starting point.`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*LinkedIn option A* (the "practitioner" angle)',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```' + linkedinA + '```',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*LinkedIn option B* (the "industry observer" angle)',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```' + linkedinB + '```',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*LinkedIn option C* (the "had enough" angle)',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```' + linkedinC + '```',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*X/Twitter*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```' + twitter + '```',
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'No pressure at all -- just here if you want them.',
        },
      ],
    },
  ];

  const message: SlackBlockMessage = {
    text: 'Welcome! Here are some ready-to-share social posts if you\'d like to announce the news.',
    blocks,
  };

  try {
    const result = await sendDirectMessage(data.slackUserId, message);
    if (result.ok) {
      logger.info({ slackUserId: data.slackUserId }, 'Sent welcome social posts DM');
      return true;
    }
    logger.warn({ slackUserId: data.slackUserId, error: result.error }, 'Failed to send welcome social posts DM');
    return false;
  } catch (error) {
    logger.error({ error, slackUserId: data.slackUserId }, 'Error sending welcome social posts DM');
    return false;
  }
}
