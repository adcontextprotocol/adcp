/**
 * Working Group Digest Builder
 *
 * Assembles per-group content for the biweekly WG digest email:
 * recent activity summaries, meeting recaps, upcoming meetings,
 * active Slack threads, and new members.
 */

import { createLogger } from '../../logger.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { MeetingsDatabase } from '../../db/meetings-db.js';
import { getChannelHistory } from '../../slack/client.js';
import { query } from '../../db/client.js';
import type { WgDigestContent, WgDigestThread, WgDigestMeetingRecap } from '../../db/wg-digest-db.js';

const logger = createLogger('wg-digest-builder');
const workingGroupDb = new WorkingGroupDatabase();
const meetingsDb = new MeetingsDatabase();

const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL || 'https://agenticads.slack.com';
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Build digest content for a single working group.
 * Returns null if there's nothing worth sending.
 */
export async function buildWgDigestContent(workingGroupId: string): Promise<WgDigestContent | null> {
  const group = await workingGroupDb.getWorkingGroupById(workingGroupId);
  if (!group || group.status !== 'active') return null;

  const [summary, meetingRecaps, nextMeeting, activeThreads, newMembers] = await Promise.all([
    getActivitySummary(workingGroupId),
    getRecentMeetingRecaps(workingGroupId),
    getNextMeeting(workingGroupId),
    getActiveThreads(group.slack_channel_id),
    getNewMembers(workingGroupId),
  ]);

  // Skip if there's nothing to report
  if (!summary && meetingRecaps.length === 0 && !nextMeeting && activeThreads.length === 0 && newMembers.length === 0) {
    return null;
  }

  return {
    groupName: group.name,
    summary,
    meetingRecaps,
    nextMeeting,
    activeThreads,
    newMembers,
  };
}

/**
 * Get all active working groups that could have digest content
 */
export async function getDigestEligibleGroups(): Promise<Array<{ id: string; name: string; slug: string }>> {
  const result = await query<{ id: string; name: string; slug: string }>(
    `SELECT id, name, slug FROM working_groups
     WHERE status = 'active'
       AND committee_type IN ('working_group', 'steering_committee')
     ORDER BY display_order`,
  );
  return result.rows;
}

async function getActivitySummary(workingGroupId: string): Promise<string | null> {
  const summaries = await workingGroupDb.getCurrentSummaries(workingGroupId);
  const activitySummary = summaries.find(s => s.summary_type === 'activity');
  return activitySummary?.summary_text?.slice(0, 500) || null;
}

async function getRecentMeetingRecaps(workingGroupId: string): Promise<WgDigestMeetingRecap[]> {
  const twoWeeksAgo = new Date(Date.now() - TWO_WEEKS_MS);
  const meetings = await meetingsDb.listMeetings({
    working_group_id: workingGroupId,
    past_only: true,
    limit: 5,
  });

  const recaps: WgDigestMeetingRecap[] = [];
  for (const meeting of meetings) {
    if (new Date(meeting.start_time) < twoWeeksAgo) continue;
    if (!meeting.summary && !meeting.title) continue;

    recaps.push({
      title: meeting.title,
      date: new Date(meeting.start_time).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
      }),
      summary: meeting.summary?.slice(0, 300) || 'No summary available.',
    });
  }

  return recaps;
}

async function getNextMeeting(workingGroupId: string): Promise<{ title: string; date: string } | null> {
  const meetings = await meetingsDb.listMeetings({
    working_group_id: workingGroupId,
    upcoming_only: true,
    limit: 1,
  });

  if (meetings.length === 0) return null;
  const next = meetings[0];

  return {
    title: next.title,
    date: new Date(next.start_time).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    }) + ' ET',
  };
}

async function getActiveThreads(slackChannelId: string | null | undefined): Promise<WgDigestThread[]> {
  if (!slackChannelId) return [];

  try {
    const twoWeeksAgo = String(Math.floor((Date.now() - TWO_WEEKS_MS) / 1000));
    const history = await getChannelHistory(slackChannelId, {
      oldest: twoWeeksAgo,
      limit: 50,
    });

    const threads = history.messages
      .filter(msg => msg.reply_count && msg.reply_count >= 3 && msg.text && !msg.bot_id)
      .sort((a, b) => (b.reply_count || 0) - (a.reply_count || 0))
      .slice(0, 3);

    return threads.map(thread => ({
      summary: thread.text!.slice(0, 150),
      replyCount: thread.reply_count || 0,
      threadUrl: `${SLACK_WORKSPACE_URL}/archives/${slackChannelId}/p${thread.ts.replace('.', '')}`,
    }));
  } catch (err) {
    logger.warn({ channelId: slackChannelId, error: err }, 'Failed to fetch channel history for WG digest');
    return [];
  }
}

async function getNewMembers(workingGroupId: string): Promise<string[]> {
  const twoWeeksAgo = new Date(Date.now() - TWO_WEEKS_MS);
  const result = await query<{ user_name: string }>(
    `SELECT user_name FROM working_group_memberships
     WHERE working_group_id = $1
       AND status = 'active'
       AND joined_at > $2
     ORDER BY joined_at DESC
     LIMIT 10`,
    [workingGroupId, twoWeeksAgo.toISOString()],
  );
  return result.rows.map(r => r.user_name).filter(Boolean);
}
