/**
 * Addie Meeting Tools
 *
 * Tools for meeting management through natural conversation.
 * Enables scheduling, listing, and managing working group meetings via Slack.
 *
 * Meeting scheduling flow:
 * 1. User describes the meeting they want to schedule
 * 2. Addie uses schedule_meeting tool to create in Zoom + Google Calendar + database
 * 3. Invites are sent to working group members based on topic subscriptions
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import type { ThreadContext } from '../thread-service.js';
import type { RecurrenceRule, CreateMeetingSeriesInput } from '../../types.js';
import { isSlackUserAAOAdmin } from './admin-tools.js';
import { isAuthenticatedUserAAOAdmin, type AAOAdminPrincipal } from '../admin-status-lookup.js';
import { MeetingsDatabase } from '../../db/meetings-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import * as meetingService from '../../services/meeting-service.js';
import * as zoom from '../../integrations/zoom.js';
import * as calendar from '../../integrations/google-calendar.js';
import {
  formatZonedTimestamp,
  isValidIanaTimeZone,
  parseZonedTimestamp,
} from '../tool-temporal.js';
import { MEETING_TOOLS } from './meeting-tool-definitions.js';

const logger = createLogger('addie-meeting-tools');

const meetingsDb = new MeetingsDatabase();
const workingGroupDb = new WorkingGroupDatabase();

/**
 * Check if a Slack user can schedule meetings
 * Must be an admin or working group leader
 */
export async function canScheduleMeetings(slackUserId: string): Promise<boolean> {
  // Admins can always schedule
  const isAdmin = await isSlackUserAAOAdmin(slackUserId);
  if (isAdmin) return true;

  // Check if user is a leader of any working group
  // getCommitteesLedByUser handles both Slack user IDs and WorkOS user IDs
  const ledGroups = await workingGroupDb.getCommitteesLedByUser(slackUserId);
  if (ledGroups.length > 0) {
    logger.debug({ slackUserId, groupCount: ledGroups.length }, 'User is a working group leader');
    return true;
  }

  return false;
}


/**
 * Format recurrence rule for display
 */
function formatRecurrence(rule: RecurrenceRule): string {
  const dayNames: Record<string, string> = {
    MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday',
    FR: 'Friday', SA: 'Saturday', SU: 'Sunday',
  };

  const interval = rule.interval || 1;
  let result = '';

  switch (rule.freq) {
    case 'daily':
      result = interval === 1 ? 'Daily' : `Every ${interval} days`;
      break;
    case 'weekly':
      if (rule.byDay && rule.byDay.length > 0) {
        const days = rule.byDay.map(d => dayNames[d] || d).join(', ');
        result = interval === 1 ? `Weekly on ${days}` : `Every ${interval} weeks on ${days}`;
      } else {
        result = interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
      }
      break;
    case 'monthly':
      result = interval === 1 ? 'Monthly' : `Every ${interval} months`;
      break;
  }

  if (rule.count) {
    result += ` (${rule.count} occurrences)`;
  }

  return result;
}

export { MEETING_TOOLS };

/**
 * Meeting tool handler implementations
 */
export function createMeetingToolHandlers(
  memberContext?: MemberContext | null,
  slackUserId?: string,
  threadContext?: ThreadContext | null,
  adminPrincipal?: AAOAdminPrincipal,
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // Helper to get user ID
  const getUserId = (): string | undefined => {
    return memberContext?.workos_user?.workos_user_id || slackUserId;
  };

  // Helper to get working group slug from channel context
  const getChannelWorkingGroupSlug = (): string | undefined => {
    return threadContext?.viewing_channel_working_group_slug;
  };

  // Helper to check scheduling permission
  const checkSchedulePermission = async (): Promise<string | null> => {
    if (adminPrincipal) {
      if (await isAuthenticatedUserAAOAdmin(adminPrincipal)) return null;
      const credentialId = adminPrincipal.authWorkosUserId ?? adminPrincipal.id;
      const ledGroups = await workingGroupDb.getCommitteesLedByUser(credentialId);
      if (ledGroups.length === 0) {
        return '⚠️ You need to be an admin or committee leader to schedule meetings.';
      }
    } else if (slackUserId) {
      const canSchedule = await canScheduleMeetings(slackUserId);
      if (!canSchedule) {
        return '⚠️ You need to be an admin or committee leader to schedule meetings.';
      }
    } else if (memberContext) {
      if (memberContext.org_membership?.role !== 'admin') {
        return '⚠️ You need to be an admin or committee leader to schedule meetings.';
      }
    }
    return null;
  };

  // Schedule meeting
  handlers.set('schedule_meeting', async (input) => {
    const permCheck = await checkSchedulePermission();
    if (permCheck) return permCheck;

    // Get working group slug - prefer explicit, fall back to channel context
    let workingGroupSlug = input.working_group_slug as string | undefined;
    if (!workingGroupSlug) {
      workingGroupSlug = getChannelWorkingGroupSlug();
      if (!workingGroupSlug) {
        return `❌ No working group specified and this channel isn't associated with a working group. Please provide a working_group_slug (e.g., "technical", "governance", "creative").`;
      }
      logger.debug({ workingGroupSlug }, 'Using working group from channel context');
    }

    const title = input.title as string;
    const startTimeStr = input.start_time as string;
    const timezone = (input.timezone as string) || memberContext?.timezone || 'America/New_York';
    const recurrenceInput = input.recurrence as { freq: string; interval?: number; by_day?: string[]; count?: number } | undefined;

    // Find working group
    const workingGroup = await workingGroupDb.getWorkingGroupBySlug(workingGroupSlug);
    if (!workingGroup) {
      return `❌ Working group not found: "${workingGroupSlug}". Check the slug and try again.`;
    }

    // Non-admin users can only schedule meetings for groups they lead
    // This check runs for both Slack and web channels
    const userId = getUserId();
    const authorizationUserId = adminPrincipal
      ? adminPrincipal.authWorkosUserId ?? adminPrincipal.id
      : userId;
    if (authorizationUserId) {
      // Determine AAO admin status from either Slack or web context
      let isAAOAdmin = false;
      if (adminPrincipal) {
        isAAOAdmin = await isAuthenticatedUserAAOAdmin(adminPrincipal);
      } else if (slackUserId) {
        isAAOAdmin = await isSlackUserAAOAdmin(slackUserId);
      }

      if (!isAAOAdmin) {
        const isGroupLeader = await workingGroupDb.isLeader(workingGroup.id, authorizationUserId);
        if (!isGroupLeader) {
          return `⚠️ You can only schedule meetings for committees you lead. You're not a leader of "${workingGroup.name}".`;
        }
      }
    }

    const parsedStartTime = parseZonedTimestamp(startTimeStr, timezone);
    if (!parsedStartTime.ok) {
      return `❌ Invalid start_time: ${parsedStartTime.error}.`;
    }
    const startTime = parsedStartTime.date;

    if (startTime.getTime() <= Date.now()) {
      return `❌ Meeting time must be in the future. Current instant: ${new Date().toISOString()}.`;
    }

    const durationMinutes = (input.duration_minutes as number) || 60;

    // Extract invite settings (used by both one-time and recurring paths)
    const inviteMode = input.invite_mode as 'all_members' | 'topic_subscribers' | 'slack_channel' | 'none' | undefined;
    const inviteSlackChannelId = input.invite_slack_channel_id as string | undefined;

    // Validate slack_channel mode has a channel ID
    if (inviteMode === 'slack_channel' && !inviteSlackChannelId) {
      return `❌ When using invite_mode='slack_channel', you must also provide invite_slack_channel_id.`;
    }

    // Handle recurring vs one-time meetings
    if (recurrenceInput) {
      // Validate recurrence input
      const validFreqs = ['daily', 'weekly', 'monthly'];
      if (!validFreqs.includes(recurrenceInput.freq)) {
        return `❌ Invalid recurrence frequency: "${recurrenceInput.freq}". Must be daily, weekly, or monthly.`;
      }

      if (recurrenceInput.interval !== undefined && (recurrenceInput.interval < 1 || recurrenceInput.interval > 52)) {
        return `❌ Invalid interval: ${recurrenceInput.interval}. Must be between 1 and 52.`;
      }

      if (recurrenceInput.count !== undefined && (recurrenceInput.count < 1 || recurrenceInput.count > 52)) {
        return `❌ Invalid count: ${recurrenceInput.count}. Must be between 1 and 52.`;
      }

      const validDays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
      if (recurrenceInput.by_day) {
        const invalidDays = recurrenceInput.by_day.filter(d => !validDays.includes(d));
        if (invalidDays.length > 0) {
          return `❌ Invalid day(s): ${invalidDays.join(', ')}. Must be MO, TU, WE, TH, FR, SA, or SU.`;
        }
      }

      // Create a recurring meeting series
      try {
        const recurrenceRule: RecurrenceRule = {
          freq: recurrenceInput.freq as 'daily' | 'weekly' | 'monthly',
          interval: recurrenceInput.interval || 1,
          byDay: recurrenceInput.by_day,
          count: recurrenceInput.count,
        };

        // Extract time-of-day from the original string (already in user's timezone)
        const timePart = startTimeStr.split('T')[1] || '14:00:00';
        const defaultStartTime = timePart.substring(0, 8).padEnd(8, ':00');

        // Check for existing active series on this working group with same title
        const existingSeries = await meetingsDb.listSeriesForGroup(workingGroup.id, { status: 'active' });
        const duplicate = existingSeries.find(s => s.title === title);
        if (duplicate) {
          const seriesMeetings = await meetingsDb.listMeetings({ series_id: duplicate.id, upcoming_only: true });
          if (seriesMeetings.length === 0) {
            // All meetings cancelled — auto-archive the stale series
            await meetingsDb.updateSeries(duplicate.id, { status: 'archived' });
            logger.info({ seriesId: duplicate.id }, 'Auto-archived stale series with no upcoming meetings');
          } else {
            return `❌ A recurring series "${title}" already exists for ${workingGroup.name} with ${seriesMeetings.length} upcoming meeting(s) (series_id: ${duplicate.id}). To start fresh, cancel the existing series first using cancel_meeting_series with series_id "${duplicate.id}".`;
          }
        }

        // Create the meeting series
        const seriesInput: CreateMeetingSeriesInput = {
          working_group_id: workingGroup.id,
          title,
          description: input.description as string | undefined,
          topic_slugs: input.topic_slugs as string[] | undefined,
          recurrence_rule: recurrenceRule,
          default_start_time: defaultStartTime,
          duration_minutes: durationMinutes,
          timezone,
          created_by_user_id: getUserId(),
          invite_mode: inviteMode === 'none' ? 'manual' : (inviteMode || 'all_members'),
          invite_slack_channel_id: inviteSlackChannelId,
        };

        const series = await meetingsDb.createSeries(seriesInput);
        logger.info({ seriesId: series.id, workingGroupSlug, recurrence: recurrenceRule }, 'Meeting series created');

        // Generate the first batch of meetings, anchored to the user's requested start date
        const MAX_MEETINGS_PER_BATCH = 12;
        const meetingsToGenerate = recurrenceInput.count || 4;
        const actualCount = Math.min(meetingsToGenerate, MAX_MEETINGS_PER_BATCH);
        const seriesResult = await meetingService.generateMeetingsFromSeries(series.id, actualCount, startTime);

        // Build response
        let response = `✅ Created recurring meeting series: **${title}**\n\n`;
        response += `**Working Group:** ${workingGroup.name}\n`;
        response += `**Recurrence:** ${formatRecurrence(recurrenceRule)}\n`;
        response += `**Duration:** ${durationMinutes} minutes\n\n`;

        if (seriesResult.meetings.length > 0) {
          response += `**Scheduled ${seriesResult.meetings.length} meeting${seriesResult.meetings.length > 1 ? 's' : ''}:**\n`;
          for (const meeting of seriesResult.meetings.slice(0, 5)) {
            response += `• ${formatZonedTimestamp(meeting.start_time, timezone)}`;
            if (meeting.zoom_join_url) {
              response += ` - [Zoom](${meeting.zoom_join_url})`;
            }
            response += '\n';
          }
          if (seriesResult.meetings.length > 5) {
            response += `• _...and ${seriesResult.meetings.length - 5} more_\n`;
          }
        }

        if (seriesResult.errors.length > 0) {
          response += `\n⚠️ Some integrations had issues:\n`;
          response += seriesResult.errors.map(e => `• ${e}`).join('\n');
        }

        if (meetingsToGenerate > MAX_MEETINGS_PER_BATCH) {
          response += `\n\n⚠️ Created ${actualCount} of ${meetingsToGenerate} requested meetings. Additional meetings can be generated later.`;
        }

        if (seriesResult.errors.length === 0) {
          const seriesInviteMode = series.invite_mode || 'all_members';
          if (seriesInviteMode === 'manual') {
            response += `\n📋 Meetings created as **opt-in** - no invites sent. Members can join using the Zoom links.`;
          } else if (seriesInviteMode === 'slack_channel') {
            response += `\n📧 Calendar invites sent to Slack channel members for each meeting.`;
          } else if (seriesInviteMode === 'topic_subscribers') {
            response += `\n📧 Calendar invites sent to topic subscribers for each meeting.`;
          } else {
            response += `\n📧 Calendar invites sent to working group members for each meeting.`;
          }
        }

        logger.info({
          seriesId: series.id,
          workingGroupSlug,
          meetingsCreated: seriesResult.meetings.length,
          scheduledBy: getUserId(),
        }, 'Recurring meeting series scheduled via Addie');

        return response;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error }, 'Failed to create recurring meeting series via Addie');
        return `❌ Failed to create recurring meetings: ${msg}`;
      }
    }

    // One-time meeting
    try {
      const result = await meetingService.scheduleMeeting({
        workingGroupId: workingGroup.id,
        title,
        description: input.description as string | undefined,
        agenda: input.agenda as string | undefined,
        topicSlugs: input.topic_slugs as string[] | undefined,
        startTime,
        durationMinutes,
        timezone,
        createdByUserId: getUserId(),
        inviteMode,
        inviteSlackChannelId,
      });

      let response = `✅ Scheduled: **${title}**\n\n`;
      response += `**Working Group:** ${workingGroup.name}\n`;
      response += `**When:** ${formatZonedTimestamp(startTime, timezone)}\n`;
      response += `**Duration:** ${durationMinutes} minutes\n`;

      if (result.meeting.zoom_join_url) {
        response += `**Zoom:** ${result.meeting.zoom_join_url}\n`;
      }

      if (result.errors.length > 0) {
        response += `\n⚠️ Some integrations had issues:\n`;
        response += result.errors.map(e => `• ${e}`).join('\n');
      } else if (inviteMode === 'none') {
        response += `\n📋 Meeting created as **opt-in** - no invites sent. Members can join using the Zoom link.`;
      } else if (inviteMode === 'slack_channel') {
        response += `\n📧 Calendar invites sent to Slack channel members.`;
      } else if (inviteMode === 'topic_subscribers') {
        response += `\n📧 Calendar invites sent to topic subscribers.`;
      } else {
        response += `\n📧 Calendar invites sent to working group members.`;
      }

      logger.info({
        meetingId: result.meeting.id,
        workingGroupSlug,
        scheduledBy: getUserId(),
      }, 'Meeting scheduled via Addie');

      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, 'Failed to schedule meeting via Addie');
      return `❌ Failed to schedule meeting: ${msg}`;
    }
  });

  // List upcoming meetings
  handlers.set('list_upcoming_meetings', async (input) => {
    const workingGroupSlug = input.working_group_slug as string | undefined;
    const myCommitteesOnly = input.my_committees_only as boolean | undefined;
    const limit = Math.min((input.limit as number) || 10, 20);

    let workingGroupId: string | undefined;
    let workingGroupIds: string[] | undefined;
    let groupName: string | undefined;
    let filterDescription: string | undefined;

    if (workingGroupSlug) {
      const group = await workingGroupDb.getWorkingGroupBySlug(workingGroupSlug);
      if (!group) {
        return `❌ Working group not found: "${workingGroupSlug}"`;
      }
      workingGroupId = group.id;
      groupName = group.name;
    } else if (myCommitteesOnly) {
      const userId = getUserId();
      if (!userId) {
        return '❌ Unable to identify you. Please make sure you\'re logged in.';
      }
      const userGroups = await workingGroupDb.getWorkingGroupsForUser(userId);
      if (userGroups.length === 0) {
        return 'You are not a member of any committees.';
      }
      workingGroupIds = userGroups.map(g => g.id);
      filterDescription = 'your committees';
    }

    const meetings = await meetingsDb.listMeetings({
      working_group_id: workingGroupId,
      working_group_ids: workingGroupIds,
      upcoming_only: true,
      limit,
    });

    if (meetings.length === 0) {
      let msg = 'No upcoming meetings';
      if (groupName) msg += ` for ${groupName}`;
      else if (filterDescription) msg += ` for ${filterDescription}`;
      return msg + '.';
    }

    let response = `## Upcoming Meetings`;
    if (groupName) response += ` - ${groupName}`;
    else if (filterDescription) response += ` - ${filterDescription}`;
    response += `\n\n`;

    for (const meeting of meetings) {
      response += `📅 **${meeting.title}**\n`;
      response += `   ID: ${meeting.id}\n`;
      response += `   ${formatZonedTimestamp(meeting.start_time, meeting.timezone)}\n`;
      if (!groupName) {
        response += `   Group: ${meeting.working_group_name}\n`;
      }
      if (meeting.accepted_count && meeting.accepted_count > 0) {
        response += `   👥 ${meeting.accepted_count} attending\n`;
      }
      if (meeting.zoom_join_url) {
        response += `   🔗 ${meeting.zoom_join_url}\n`;
      }
      response += `\n`;
    }

    return response;
  });

  // Get user's meetings
  handlers.set('get_my_meetings', async (input) => {
    const userId = getUserId();
    if (!userId) {
      return '❌ Unable to identify you. Please make sure you\'re logged in.';
    }

    const limit = Math.min((input.limit as number) || 10, 20);

    const meetings = await meetingsDb.getMeetingsForUser(userId, {
      upcoming_only: true,
      limit,
    });

    if (meetings.length === 0) {
      return 'You have no upcoming meetings scheduled.';
    }

    let response = `## Your Upcoming Meetings\n\n`;

    for (const meeting of meetings) {
      const statusEmoji = {
        accepted: '✅',
        tentative: '❔',
        declined: '❌',
        pending: '⏳',
      }[meeting.rsvp_status] || '📅';

      response += `${statusEmoji} **${meeting.title}**\n`;
      response += `   ${formatZonedTimestamp(meeting.start_time, meeting.timezone)}\n`;
      response += `   Group: ${meeting.working_group_name}\n`;
      if (meeting.zoom_join_url) {
        response += `   🔗 ${meeting.zoom_join_url}\n`;
      }
      response += `\n`;
    }

    return response;
  });

  // Get meeting details
  handlers.set('get_meeting_details', async (input) => {
    const inputId = input.meeting_id as string;

    // Try to find by our UUID first, then by Zoom meeting ID
    let meeting = await meetingsDb.getMeetingWithGroup(inputId);
    if (!meeting) {
      // Maybe it's a Zoom meeting ID - look that up first
      const meetingByZoom = await meetingsDb.getMeetingByZoomId(inputId);
      if (meetingByZoom) {
        meeting = await meetingsDb.getMeetingWithGroup(meetingByZoom.id);
      }
    }
    if (!meeting) {
      return `❌ Meeting not found: "${inputId}". Use list_upcoming_meetings to find the correct meeting ID.`;
    }

    const attendees = await meetingsDb.getAttendeesForMeeting(meeting.id);
    const accepted = attendees.filter(a => a.rsvp_status === 'accepted');
    const declined = attendees.filter(a => a.rsvp_status === 'declined');
    const pending = attendees.filter(a => a.rsvp_status === 'pending');

    let response = `## ${meeting.title}\n\n`;
    response += `**Working Group:** ${meeting.working_group_name}\n`;
    response += `**Status:** ${meeting.status}\n`;
    response += `**When:** ${formatZonedTimestamp(meeting.start_time, meeting.timezone)}\n`;

    if (meeting.description) {
      response += `\n**Description:**\n${meeting.description}\n`;
    }

    if (meeting.agenda) {
      response += `\n**Agenda:**\n${meeting.agenda}\n`;
    }

    response += `\n### RSVPs\n`;
    response += `• **Attending:** ${accepted.length}\n`;
    if (pending.length > 0) response += `• **Pending:** ${pending.length}\n`;
    if (declined.length > 0) response += `• **Declined:** ${declined.length}\n`;

    if (accepted.length > 0 && accepted.length <= 15) {
      response += `\n**Who's coming:**\n`;
      for (const a of accepted) {
        response += `• ${a.name || a.email || 'Unknown'}\n`;
      }
    }

    response += `\n### Links\n`;
    if (meeting.zoom_join_url) {
      response += `• Zoom: ${meeting.zoom_join_url}\n`;
    }

    return response;
  });

  // RSVP to meeting
  handlers.set('rsvp_to_meeting', async (input) => {
    const userId = getUserId();
    if (!userId) {
      return '❌ Unable to identify you. Please make sure you\'re logged in.';
    }

    const inputId = input.meeting_id as string;
    const response = input.response as 'accepted' | 'declined' | 'tentative';
    const note = input.note as string | undefined;

    // Try to find by our UUID first, then by Zoom meeting ID
    let meeting = await meetingsDb.getMeetingById(inputId);
    if (!meeting) {
      meeting = await meetingsDb.getMeetingByZoomId(inputId);
    }
    if (!meeting) {
      return `❌ Meeting not found: "${inputId}". Use list_upcoming_meetings to find the correct meeting ID.`;
    }

    // Check if user is already an attendee
    let attendee = await meetingsDb.getAttendee(meeting.id, userId);

    if (attendee) {
      // Update existing RSVP
      attendee = await meetingsDb.updateAttendee(meeting.id, userId, {
        rsvp_status: response,
        rsvp_note: note,
      });
    } else {
      // Add as new attendee
      const userEmail = memberContext?.workos_user?.email || '';
      const userName = memberContext?.workos_user?.first_name && memberContext?.workos_user?.last_name
        ? `${memberContext.workos_user.first_name} ${memberContext.workos_user.last_name}`
        : userEmail;

      attendee = await meetingsDb.addAttendee({
        meeting_id: meeting.id,
        workos_user_id: userId,
        email: userEmail,
        name: userName,
        rsvp_status: response,
        invite_source: 'request',
      });
    }

    const responseEmoji = {
      accepted: '✅',
      declined: '❌',
      tentative: '❔',
    }[response];

    return `${responseEmoji} RSVP updated for **${meeting.title}**: ${response}`;
  });

  // Cancel meeting
  handlers.set('cancel_meeting', async (input) => {
    const permCheck = await checkSchedulePermission();
    if (permCheck) return permCheck;

    const meetingId = input.meeting_id as string;

    // Try to find by our UUID first, then by Zoom meeting ID
    let meeting = await meetingsDb.getMeetingById(meetingId);
    if (!meeting) {
      // Maybe it's a Zoom meeting ID instead of our UUID
      meeting = await meetingsDb.getMeetingByZoomId(meetingId);
    }
    if (!meeting) {
      return `❌ Meeting not found: "${meetingId}". Use list_upcoming_meetings to find the correct meeting ID.`;
    }

    if (meeting.status === 'cancelled') {
      return `Meeting "${meeting.title}" is already cancelled.`;
    }

    try {
      // Use meeting.id (our UUID) not the input meetingId (might be Zoom ID)
      const result = await meetingService.cancelMeeting(meeting.id);

      let response = `✅ Cancelled: **${meeting.title}**\n`;
      response += `Cancellation notices have been sent to attendees.`;

      if (result.errors.length > 0) {
        response += `\n\n⚠️ Some cleanup had issues:\n`;
        response += result.errors.map(e => `• ${e}`).join('\n');
      }

      logger.info({ meetingId: meeting.id, cancelledBy: getUserId() }, 'Meeting cancelled via Addie');

      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Failed to cancel meeting: ${msg}`;
    }
  });

  // Cancel meeting series
  handlers.set('cancel_meeting_series', async (input) => {
    const permCheck = await checkSchedulePermission();
    if (permCheck) return permCheck;

    let seriesId = input.series_id as string;

    let series = await meetingsDb.getSeriesById(seriesId);
    if (!series) {
      // Maybe they passed a meeting ID — look up the parent series
      const meeting = await meetingsDb.getMeetingById(seriesId);
      if (meeting?.series_id) {
        seriesId = meeting.series_id;
        series = await meetingsDb.getSeriesById(seriesId);
      }
      if (!series) {
        return `❌ Meeting series not found: "${input.series_id}". Use list_upcoming_meetings to find meetings, then check series_id from get_meeting_details.`;
      }
    }

    if (series.status === 'archived') {
      return `Series "${series.title}" is already archived.`;
    }

    try {
      const result = await meetingService.cancelSeries(seriesId);

      let response = `✅ Cancelled series: **${series.title}**\n`;
      response += `${result.cancelledCount} upcoming meeting(s) cancelled.`;

      if (result.errors.length > 0) {
        response += `\n\n⚠️ Some cleanup had issues:\n`;
        response += result.errors.map(e => `• ${e}`).join('\n');
      }

      logger.info({ seriesId, cancelledBy: getUserId() }, 'Meeting series cancelled via Addie');

      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Failed to cancel series: ${msg}`;
    }
  });

  // Update meeting
  handlers.set('update_meeting', async (input) => {
    const permCheck = await checkSchedulePermission();
    if (permCheck) return permCheck;

    const meetingId = input.meeting_id as string;

    // Try to find by our UUID first, then by Zoom meeting ID
    let meeting = await meetingsDb.getMeetingById(meetingId);
    if (!meeting) {
      meeting = await meetingsDb.getMeetingByZoomId(meetingId);
    }
    if (!meeting) {
      return `❌ Meeting not found: "${meetingId}". Use list_upcoming_meetings to find the correct meeting ID.`;
    }

    if (meeting.status === 'cancelled') {
      return `❌ Cannot update a cancelled meeting.`;
    }

    // Build updates object
    const updates: Record<string, unknown> = {};
    const changes: string[] = [];

    if (input.title) {
      updates.title = input.title as string;
      changes.push(`Title → "${input.title}"`);
    }

    if (input.description !== undefined) {
      updates.description = input.description as string;
      changes.push('Description updated');
    }

    if (input.agenda !== undefined) {
      updates.agenda = input.agenda as string;
      changes.push('Agenda updated');
    }

    // Handle time updates
    const startTimeStr = input.start_time as string | undefined;
    const durationMinutes = input.duration_minutes as number | undefined;
    const timezone = (input.timezone as string) || meeting.timezone || 'America/New_York';

    // Calculate current duration from start_time and end_time
    const currentDuration = meeting.start_time && meeting.end_time
      ? Math.round((meeting.end_time.getTime() - meeting.start_time.getTime()) / 60000)
      : 60;

    if (startTimeStr) {
      const parsedStartTime = parseZonedTimestamp(startTimeStr, timezone);
      if (!parsedStartTime.ok) {
        return `❌ Invalid start_time: ${parsedStartTime.error}.`;
      }
      const startTime = parsedStartTime.date;
      if (startTime.getTime() <= Date.now()) {
        return `❌ Meeting time must be in the future. Current instant: ${new Date().toISOString()}.`;
      }
      updates.start_time = startTime;
      updates.timezone = timezone;

      const duration = durationMinutes || currentDuration;
      updates.end_time = new Date(startTime.getTime() + duration * 60 * 1000);

      changes.push(`Time → ${formatZonedTimestamp(startTime, timezone)}`);
    } else if (durationMinutes && meeting.start_time) {
      // Just updating duration, keep existing start time
      updates.end_time = new Date(meeting.start_time.getTime() + durationMinutes * 60 * 1000);
      changes.push(`Duration → ${durationMinutes} minutes`);
    }
    if (input.timezone && !startTimeStr) {
      if (!isValidIanaTimeZone(timezone)) {
        return `❌ Invalid timezone: "${timezone}" is not a valid IANA timezone.`;
      }
      updates.timezone = timezone;
      changes.push(`Time zone → ${timezone}`);
    }

    if (changes.length === 0) {
      return `No changes specified. You can update: title, description, agenda, start_time, duration_minutes, timezone.`;
    }

    try {
      // Update in database
      const updatedMeeting = await meetingsDb.updateMeeting(meeting.id, updates);
      if (!updatedMeeting) {
        return `❌ Failed to update meeting in database.`;
      }

      const errors: string[] = [];

      // Keep both the instant and its display timezone aligned in Zoom.
      if ((updates.start_time || updates.timezone) && meeting.zoom_meeting_id && zoom.isZoomConfigured()) {
        try {
          const startTime = (updates.start_time as Date | undefined) ?? meeting.start_time;
          await zoom.updateMeeting(meeting.zoom_meeting_id, {
            start_time: startTime.toISOString(),
            duration: durationMinutes || currentDuration,
            timezone,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Zoom update failed: ${msg}`);
          logger.error({ err: error, meetingId: meeting.id }, 'Failed to update Zoom meeting');
        }
      }

      // Update Google Calendar event if it exists
      if (meeting.google_calendar_event_id && calendar.isGoogleCalendarConfigured()) {
        try {
          const startTime = (updates.start_time as Date) || meeting.start_time;
          const title = (updates.title as string) || meeting.title;

          // Calculate end time - use updated value, or compute from start + duration
          let endTime = updates.end_time as Date | undefined;
          if (!endTime) {
            if (meeting.end_time) {
              endTime = meeting.end_time;
            } else {
              // Fallback: compute from start time + current duration
              endTime = new Date(startTime.getTime() + currentDuration * 60 * 1000);
            }
          }

          // Get working group for calendar event summary
          const workingGroup = await workingGroupDb.getWorkingGroupById(meeting.working_group_id);
          const summary = workingGroup ? `${workingGroup.name}: ${title}` : title;

          await calendar.updateEvent(meeting.google_calendar_event_id, {
            summary,
            description: (updates.description as string) || meeting.description || undefined,
            start: {
              dateTime: startTime.toISOString(),
              timeZone: timezone,
            },
            end: {
              dateTime: endTime.toISOString(),
              timeZone: timezone,
            },
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Calendar update failed: ${msg}`);
          logger.error({ err: error, meetingId: meeting.id }, 'Failed to update calendar event');
        }
      }

      let response = `✅ Updated: **${updatedMeeting.title}**\n\n`;
      response += `**Changes:**\n${changes.map(c => `• ${c}`).join('\n')}\n`;

      if (errors.length > 0) {
        response += `\n⚠️ Some integrations had issues:\n${errors.map(e => `• ${e}`).join('\n')}`;
      } else if (meeting.google_calendar_event_id) {
        response += `\n📧 Calendar invites have been updated.`;
      }

      logger.info({
        meetingId: meeting.id,
        changes,
        updatedBy: getUserId(),
      }, 'Meeting updated via Addie');

      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, meetingId: meeting.id }, 'Failed to update meeting via Addie');
      return `❌ Failed to update meeting: ${msg}`;
    }
  });

  // Add attendee
  handlers.set('add_meeting_attendee', async (input) => {
    const permCheck = await checkSchedulePermission();
    if (permCheck) return permCheck;

    const inputId = input.meeting_id as string;
    const email = input.email as string;
    const name = input.name as string | undefined;
    const addToSeries = input.add_to_series === true;

    // Try to find by our UUID first, then by Zoom meeting ID
    let meeting = await meetingsDb.getMeetingById(inputId);
    if (!meeting) {
      meeting = await meetingsDb.getMeetingByZoomId(inputId);
    }
    if (!meeting) {
      return `❌ Meeting not found: "${inputId}". Use list_upcoming_meetings to find the correct meeting ID.`;
    }

    try {
      // If adding to series and meeting has a series_id, add to all upcoming meetings
      if (addToSeries && meeting.series_id) {
        const result = await meetingService.addAttendeeToSeries(meeting.series_id, [
          { email, name },
        ]);

        if (result.addedToMeetings > 0) {
          let msg = `✅ Added ${name || email} to ${result.addedToMeetings} upcoming meeting(s) in the series **${meeting.title}**.`;
          if (result.errors.length > 0) {
            msg += `\n\n⚠️ Some calendar updates failed: ${result.errors.join('; ')}`;
          }
          return msg;
        } else {
          return `${name || email} was already on the invite list for all upcoming meetings in this series.`;
        }
      }

      // Single meeting add
      const result = await meetingService.addAttendeesToMeeting(meeting.id, [
        { email, name },
      ]);

      if (result.addedCount > 0) {
        const calendarNote = meeting.google_calendar_event_id ? ' Calendar invite sent.' : '';
        const seriesHint = meeting.series_id ? ' (This is a recurring meeting — use add_to_series: true to add to all upcoming occurrences.)' : '';
        return `✅ Added ${name || email} to **${meeting.title}**.${calendarNote}${seriesHint}`;
      } else {
        return `${name || email} was already on the invite list.`;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Failed to add attendee: ${msg}`;
    }
  });

  // Update topic subscriptions
  handlers.set('update_topic_subscriptions', async (input) => {
    const userId = getUserId();
    if (!userId) {
      return '❌ Unable to identify you. Please make sure you\'re logged in.';
    }

    const workingGroupSlug = input.working_group_slug as string;
    const topicSlugs = input.topic_slugs as string[];

    const workingGroup = await workingGroupDb.getWorkingGroupBySlug(workingGroupSlug);
    if (!workingGroup) {
      return `❌ Working group not found: "${workingGroupSlug}"`;
    }

    // Check membership
    const isMember = await workingGroupDb.isMember(workingGroup.id, userId);
    if (!isMember) {
      return `❌ You must be a member of ${workingGroup.name} to manage topic subscriptions.`;
    }

    // Get available topics
    const availableTopics = await meetingsDb.getTopicsForGroup(workingGroup.id);
    if (availableTopics.length === 0) {
      return `${workingGroup.name} doesn't have any topics configured yet.`;
    }

    // Validate requested topics
    const validTopics = topicSlugs.filter(slug =>
      availableTopics.some(t => t.slug === slug)
    );

    // Update subscription
    await meetingsDb.updateTopicSubscription({
      working_group_id: workingGroup.id,
      workos_user_id: userId,
      topic_slugs: validTopics,
    });

    if (validTopics.length === 0) {
      return `✅ Unsubscribed from all meeting topics in ${workingGroup.name}. You won't receive automatic meeting invites.`;
    }

    return `✅ Updated topic subscriptions for ${workingGroup.name}:\n${validTopics.map(t => `• ${t}`).join('\n')}\n\nYou'll receive meeting invites for these topics.`;
  });

  // Manage committee topics (add, update, remove, list)
  handlers.set('manage_committee_topics', async (input) => {
    const permCheck = await checkSchedulePermission();
    if (permCheck) return permCheck;

    const workingGroupSlug = input.working_group_slug as string;
    const action = input.action as 'list' | 'add' | 'update' | 'remove';

    const workingGroup = await workingGroupDb.getWorkingGroupBySlug(workingGroupSlug);
    if (!workingGroup) {
      return `❌ Working group not found: "${workingGroupSlug}"`;
    }

    const currentTopics = workingGroup.topics || [];

    // List topics
    if (action === 'list') {
      if (currentTopics.length === 0) {
        return `📋 **${workingGroup.name}** has no topics configured yet.\n\nUse action='add' to create a topic for organizing meetings and invitations.`;
      }

      let response = `📋 **Topics for ${workingGroup.name}:**\n\n`;
      for (const topic of currentTopics) {
        response += `**${topic.name}** (\`${topic.slug}\`)\n`;
        if (topic.description) {
          response += `  ${topic.description}\n`;
        }
        if (topic.slack_channel_id) {
          response += `  📢 Slack channel: ${topic.slack_channel_id}\n`;
        }
        response += '\n';
      }
      return response.trim();
    }

    // All other actions require topic_slug
    const topicSlug = input.topic_slug as string | undefined;
    if (!topicSlug) {
      return `❌ topic_slug is required for action='${action}'`;
    }

    // Validate topic slug format (lowercase letters, numbers, hyphens only)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topicSlug)) {
      return `❌ Invalid topic slug "${topicSlug}". Slugs must be lowercase letters, numbers, and hyphens only (e.g., "my-topic-1").`;
    }

    // Add topic
    if (action === 'add') {
      const topicName = input.topic_name as string | undefined;
      if (!topicName) {
        return `❌ topic_name is required when adding a new topic`;
      }

      // Check for duplicate slug
      if (currentTopics.some(t => t.slug === topicSlug)) {
        return `❌ A topic with slug "${topicSlug}" already exists in ${workingGroup.name}`;
      }

      const newTopic = {
        slug: topicSlug,
        name: topicName,
        description: input.topic_description as string | undefined,
        slack_channel_id: input.slack_channel_id as string | undefined,
      };

      const updatedTopics = [...currentTopics, newTopic];
      await workingGroupDb.updateWorkingGroup(workingGroup.id, { topics: updatedTopics });

      let response = `✅ Added topic **${topicName}** (\`${topicSlug}\`) to ${workingGroup.name}`;
      if (newTopic.slack_channel_id) {
        response += `\n📢 Linked Slack channel: ${newTopic.slack_channel_id}`;
      }
      return response;
    }

    // Find existing topic for update/remove
    const existingIndex = currentTopics.findIndex(t => t.slug === topicSlug);
    if (existingIndex === -1) {
      return `❌ Topic "${topicSlug}" not found in ${workingGroup.name}`;
    }

    // Update topic
    if (action === 'update') {
      const existing = currentTopics[existingIndex];
      const updatedTopic = {
        ...existing,
        name: (input.topic_name as string | undefined) || existing.name,
        description: input.topic_description !== undefined ? (input.topic_description as string | undefined) : existing.description,
        slack_channel_id: input.slack_channel_id !== undefined ? (input.slack_channel_id as string | undefined) : existing.slack_channel_id,
      };

      const updatedTopics = [...currentTopics];
      updatedTopics[existingIndex] = updatedTopic;
      await workingGroupDb.updateWorkingGroup(workingGroup.id, { topics: updatedTopics });

      let response = `✅ Updated topic **${updatedTopic.name}** (\`${topicSlug}\`) in ${workingGroup.name}`;
      if (updatedTopic.slack_channel_id) {
        response += `\n📢 Linked Slack channel: ${updatedTopic.slack_channel_id}`;
      }
      return response;
    }

    // Remove topic
    if (action === 'remove') {
      const removedTopic = currentTopics[existingIndex];
      const updatedTopics = currentTopics.filter((_, i) => i !== existingIndex);
      await workingGroupDb.updateWorkingGroup(workingGroup.id, { topics: updatedTopics });

      return `✅ Removed topic **${removedTopic.name}** (\`${topicSlug}\`) from ${workingGroup.name}`;
    }

    return `❌ Unknown action: ${action}`;
  });

  return handlers;
}
