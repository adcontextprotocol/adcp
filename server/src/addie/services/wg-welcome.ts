/**
 * Working Group Welcome Message
 *
 * Sends a personalized welcome to new WG members via Slack DM
 * (or in-app notification if no Slack mapping exists).
 * Includes group context: leaders, next meeting, Slack channel link.
 */

import { createLogger } from '../../logger.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { MeetingsDatabase } from '../../db/meetings-db.js';
import { NotificationDatabase } from '../../db/notification-db.js';
import { sendDirectMessage } from '../../slack/client.js';
import { resolvePersonId, recordAddieMessage } from '../../db/relationship-db.js';

const logger = createLogger('wg-welcome');
const slackDb = new SlackDatabase();
const workingGroupDb = new WorkingGroupDatabase();
const meetingsDb = new MeetingsDatabase();
const notificationDb = new NotificationDatabase();

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

/**
 * Send a welcome message to a user who just joined a working group.
 * Fire-and-forget safe — errors are logged but never thrown.
 */
export async function sendWgWelcomeMessage(params: {
  userId: string;
  userEmail: string;
  userName: string;
  workingGroupId: string;
  workingGroupSlug: string;
  workingGroupName: string;
}): Promise<void> {
  const { userId, userEmail, workingGroupId, workingGroupSlug, workingGroupName } = params;

  try {
    // Don't send duplicate welcomes (e.g. leave + rejoin)
    const alreadyWelcomed = await notificationDb.exists(userId, 'wg_welcome', workingGroupId);
    if (alreadyWelcomed) {
      logger.debug({ userId, workingGroupSlug }, 'WG welcome already sent, skipping');
      return;
    }

    // Gather group context
    const [group, groupMeetings] = await Promise.all([
      workingGroupDb.getWorkingGroupById(workingGroupId),
      meetingsDb.listMeetings({ working_group_id: workingGroupId, upcoming_only: true, limit: 1 }),
    ]);

    const leaders = group?.leaders || [];
    const leaderNames = leaders.map(l => l.name).filter((n): n is string => Boolean(n));
    const nextMeeting = groupMeetings[0];

    // Build the message
    const message = buildWelcomeMessage({
      groupName: workingGroupName,
      groupSlug: workingGroupSlug,
      leaderNames,
      nextMeeting: nextMeeting ? {
        title: nextMeeting.title,
        startTime: new Date(nextMeeting.start_time),
      } : undefined,
      slackChannelId: group?.slack_channel_id || undefined,
      description: group?.description || undefined,
    });

    // Try Slack DM first, fall back to in-app notification
    const slackMapping = await slackDb.getByWorkosUserId(userId);
    let deliveryChannel = 'notification';

    if (slackMapping?.slack_user_id) {
      const result = await sendDirectMessage(slackMapping.slack_user_id, { text: message });
      if (result.ok) {
        deliveryChannel = 'slack';
      }
    }

    // Always create an in-app notification as well
    await notificationDb.createNotification({
      recipientUserId: userId,
      type: 'wg_welcome',
      referenceId: workingGroupId,
      referenceType: 'working_group',
      title: `Welcome to ${workingGroupName}!`,
      url: `/working-groups/${workingGroupSlug}`,
    });

    // Record in relationship model
    try {
      const personId = await resolvePersonId({ workos_user_id: userId, email: userEmail });
      await recordAddieMessage(personId, deliveryChannel);
    } catch {
      // Non-critical — relationship tracking shouldn't block welcome
    }

    logger.info({ userId, workingGroupSlug, deliveryChannel }, 'WG welcome sent');
  } catch (error) {
    logger.error({ err: error, userId, workingGroupSlug }, 'Failed to send WG welcome');
  }
}

function buildWelcomeMessage(params: {
  groupName: string;
  groupSlug: string;
  leaderNames: string[];
  nextMeeting?: { title: string; startTime: Date };
  slackChannelId?: string;
  description?: string;
}): string {
  const { groupName, groupSlug, leaderNames, nextMeeting, slackChannelId, description } = params;

  const lines: string[] = [];

  lines.push(`Welcome to *${groupName}*!`);

  // Brief description if available (first sentence only)
  if (description) {
    const firstSentence = description.split(/(?<=[.!?])\s/)[0]?.trim();
    if (firstSentence && firstSentence.length < 200) {
      lines.push(firstSentence);
    }
  }

  // Leaders
  if (leaderNames.length > 0) {
    const names = leaderNames.length <= 2
      ? leaderNames.join(' and ')
      : `${leaderNames.slice(0, -1).join(', ')}, and ${leaderNames[leaderNames.length - 1]}`;
    lines.push(`This group is led by ${names}.`);
  }

  // Next meeting
  if (nextMeeting) {
    const dateStr = nextMeeting.startTime.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York',
    });
    const timeStr = nextMeeting.startTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    });
    lines.push(`Your next meeting is *${dateStr} at ${timeStr} ET* — ${nextMeeting.title}.`);
  }

  // Call to action
  if (slackChannelId) {
    lines.push(`Jump into <#${slackChannelId}> to say hi — the group would love to hear what brought you here.`);
  } else {
    lines.push(`Check out the group page to see what's happening: ${BASE_URL}/working-groups/${groupSlug}`);
  }

  return lines.join('\n\n');
}
