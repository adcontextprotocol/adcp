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
import { getChannelHistory, getThreadReplies, resolveSlackUserDisplayName } from '../../slack/client.js';
import { query } from '../../db/client.js';
import type { WgDigestContent, WgDigestThread, WgDigestMeetingRecap } from '../../db/wg-digest-db.js';

const logger = createLogger('wg-digest-builder');
const workingGroupDb = new WorkingGroupDatabase();
const meetingsDb = new MeetingsDatabase();

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';
const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL || 'https://agenticads.slack.com';
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

/** Strip Slack mrkdwn references (<#C...|name>, <@U...>, <!subteam...>) to plain text. */
function cleanSlackMarkup(text: string): string {
  return text
    .replace(/<#[A-Za-z0-9]+\|([^>]+)>/g, '#$1')   // <#C123|general> → #general
    .replace(/<#[A-Za-z0-9]+>/g, '')                  // <#C123> (no label) → remove
    .replace(/<@[A-Za-z0-9]+>/g, '')                  // <@U123> → remove (can't resolve here)
    .replace(/<!subteam\^[A-Za-z0-9]+(?:\|([^>]+))?>/g, (_m, label) => label ? `@${label}` : '')
    .replace(/<!(everyone|channel|here)>/g, '')        // <!everyone> etc → remove
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')             // <url|label> → label
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')            // <url> → url
    .replace(/\s{2,}/g, ' ')                           // collapse leftover whitespace
    .trim();
}

/** Truncate text at the nearest word boundary before maxLen, adding ellipsis. */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

/** Strip leading markdown headings (e.g. "## Group Name\n") from summary text. */
function stripLeadingHeading(text: string): string {
  return text.replace(/^#{1,6}\s+[^\n]*\n?/, '').trim();
}

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
    getActiveThreads(group.slack_channel_id, group.name),
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
  if (!activitySummary?.summary_text) return null;
  const cleaned = stripLeadingHeading(activitySummary.summary_text);
  return truncateAtWord(cleaned, 500);
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
    if (!meeting.title) continue;

    recaps.push({
      title: meeting.title,
      date: new Date(meeting.start_time).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
      }),
      summary: meeting.summary ? truncateAtWord(stripLeadingHeading(meeting.summary), 300) : null,
      meetingUrl: `${BASE_URL}/meetings/${meeting.id}`,
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

async function getActiveThreads(slackChannelId: string | null | undefined, groupName?: string): Promise<WgDigestThread[]> {
  if (!slackChannelId) return [];

  try {
    const twoWeeksAgo = String(Math.floor((Date.now() - TWO_WEEKS_MS) / 1000));
    const history = await getChannelHistory(slackChannelId, {
      oldest: twoWeeksAgo,
      limit: 50,
    });

    const topThreads = history.messages
      .filter(msg => msg.reply_count && msg.reply_count >= 3 && msg.text && !msg.bot_id)
      .sort((a, b) => (b.reply_count || 0) - (a.reply_count || 0))
      .slice(0, 3);

    // Enrich each thread sequentially to avoid Slack API rate limits
    const enriched: WgDigestThread[] = [];
    for (const thread of topThreads) {
      const item: WgDigestThread = {
        summary: truncateAtWord(cleanSlackMarkup(thread.text!), 300),
        replyCount: thread.reply_count || 0,
        threadUrl: `${SLACK_WORKSPACE_URL}/archives/${slackChannelId}/p${thread.ts.replace('.', '')}`,
      };

      // Resolve who started the thread
      if (thread.user) {
        try {
          const resolved = await resolveSlackUserDisplayName(thread.user);
          if (resolved?.display_name) item.starter = resolved.display_name;
        } catch { /* non-critical */ }
      }

      // Fetch replies to get participant count and latest reply
      try {
        const replies = await getThreadReplies(slackChannelId, thread.ts);
        if (replies.length > 1) {
          const uniqueUsers = new Set(replies.map(r => r.user).filter(Boolean));
          item.participantCount = uniqueUsers.size;

          const lastReply = replies[replies.length - 1];
          if (lastReply.text && lastReply.ts !== thread.ts) {
            item.latestReply = truncateAtWord(cleanSlackMarkup(lastReply.text), 150);
          }
        }
      } catch { /* non-critical */ }

      enriched.push(item);
    }

    return enriched;
  } catch (err) {
    logger.error({ channelId: slackChannelId, groupName, error: err }, `Failed to fetch Slack threads for WG digest${groupName ? ` (${groupName})` : ''} — is the bot in channel ${slackChannelId}?`);
    return [];
  }
}

export interface WgDigestGap {
  groupName: string;
  groupSlug: string;
  meetingsWithoutNotes: Array<{ title: string; date: string; meetingUrl: string }>;
  missingSummary: boolean;
}

/**
 * Identify content gaps for a working group ahead of the digest.
 * Returns null if everything looks good.
 * Caller is responsible for filtering to active groups.
 */
export async function checkDigestGaps(
  workingGroupId: string,
  groupName: string,
  groupSlug: string,
): Promise<WgDigestGap | null> {
  const twoWeeksAgo = new Date(Date.now() - TWO_WEEKS_MS);
  const [summaries, meetings] = await Promise.all([
    workingGroupDb.getCurrentSummaries(workingGroupId),
    meetingsDb.listMeetings({ working_group_id: workingGroupId, past_only: true, limit: 5 }),
  ]);

  const missingSummary = !summaries.find(s => s.summary_type === 'activity')?.summary_text;

  const meetingsWithoutNotes = meetings
    .filter(m => new Date(m.start_time) >= twoWeeksAgo && m.title && !m.summary)
    .map(m => ({
      title: m.title,
      date: new Date(m.start_time).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York',
      }),
      meetingUrl: `${BASE_URL}/meetings/${m.id}`,
    }));

  if (!missingSummary && meetingsWithoutNotes.length === 0) return null;

  return {
    groupName,
    groupSlug,
    meetingsWithoutNotes,
    missingSummary,
  };
}

/**
 * Get leader emails for a working group.
 */
export async function getLeaderEmails(workingGroupId: string): Promise<Array<{
  workosUserId: string;
  email: string;
  firstName: string | null;
}>> {
  const leaders = await workingGroupDb.getLeaders(workingGroupId);
  if (leaders.length === 0) return [];

  const canonicalIds = leaders.map(l => l.canonical_user_id);
  const result = await query<{ workos_user_id: string; email: string; first_name: string | null }>(
    `SELECT u.workos_user_id, u.email, u.first_name FROM users u
     WHERE u.workos_user_id = ANY($1)
       AND u.email IS NOT NULL AND u.email != ''
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         JOIN user_email_category_preferences uecp ON uecp.user_preference_id = uep.id
         WHERE uep.workos_user_id = u.workos_user_id
           AND uecp.category_id = 'working_groups'
           AND uecp.enabled = FALSE
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         WHERE uep.workos_user_id = u.workos_user_id
           AND uep.global_unsubscribe = TRUE
       )`,
    [canonicalIds],
  );

  if (result.rows.length < canonicalIds.length) {
    const resolved = new Set(result.rows.map(r => r.workos_user_id));
    const missing = canonicalIds.filter(id => !resolved.has(id));
    if (missing.length > 0) {
      logger.warn({ workingGroupId, missingLeaderIds: missing }, 'Some leaders could not be resolved to emails (Slack-only or opted out)');
    }
  }

  return result.rows.map(r => ({ workosUserId: r.workos_user_id, email: r.email, firstName: r.first_name }));
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
