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
import { isSlackUserAdmin } from './admin-tools.js';
import { MeetingsDatabase } from '../../db/meetings-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import * as meetingService from '../../services/meeting-service.js';
import * as zoom from '../../integrations/zoom.js';
import * as calendar from '../../integrations/google-calendar.js';

const logger = createLogger('addie-meeting-tools');

const meetingsDb = new MeetingsDatabase();
const workingGroupDb = new WorkingGroupDatabase();

/**
 * Check if a Slack user can schedule meetings
 * Must be an admin or working group leader
 */
export async function canScheduleMeetings(slackUserId: string): Promise<boolean> {
  // Admins can always schedule
  const isAdmin = await isSlackUserAdmin(slackUserId);
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
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Format time for display
 */
function formatTime(date: Date, timezone = 'America/New_York'): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
    timeZoneName: 'short',
  });
}

/**
 * Get the current time as an ISO string in a specific timezone (for comparison).
 * Returns format like "2026-01-15T09:30:00"
 */
function getNowInTimezone(timezone: string): string {
  // 'sv-SE' locale gives us ISO-like format: "2026-01-15 09:30:00"
  return new Date().toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
}

/**
 * Check if a datetime string (without timezone) represents a future time
 * in the specified timezone.
 */
function isFutureTimeInTimezone(isoString: string, timezone: string): boolean {
  // If the string has timezone info, convert to the target timezone for comparison
  if (/Z|[+-]\d{2}:\d{2}$/.test(isoString)) {
    const date = new Date(isoString);
    const dateInTz = date.toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
    return dateInTz > getNowInTimezone(timezone);
  }

  // No timezone info - treat the string as already being in the target timezone
  // Just compare strings directly (ISO format is lexicographically sortable)
  const normalizedInput = isoString.substring(0, 19); // Take just "YYYY-MM-DDTHH:MM:SS"
  return normalizedInput > getNowInTimezone(timezone);
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

/**
 * Parse natural language date/time
 * Handles formats like "next Tuesday at 3pm ET", "January 15 at 2pm PT"
 */
function parseDateTime(input: string, defaultTimezone = 'America/New_York'): { date: Date; timezone: string } | null {
  // This is a simplified parser - in production, use a library like chrono-node
  const now = new Date();

  // Try ISO format first
  const isoDate = new Date(input);
  if (!isNaN(isoDate.getTime())) {
    return { date: isoDate, timezone: defaultTimezone };
  }

  // Extract timezone
  let timezone = defaultTimezone;
  const tzMatch = input.match(/\b(ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT)\b/i);
  if (tzMatch) {
    const tzMap: Record<string, string> = {
      ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
      PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
      CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
      MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
    };
    timezone = tzMap[tzMatch[1].toUpperCase()] || defaultTimezone;
  }

  // Try to parse common formats
  // For now, require ISO format or defer to Claude's interpretation
  return null;
}

/**
 * Meeting tool definitions
 */
export const MEETING_TOOLS: AddieTool[] = [
  {
    name: 'schedule_meeting',
    description: `Schedule a new working group meeting. Use this when someone asks to schedule a meeting, call, or discussion.
The meeting will be created with a Zoom link and calendar invites will be sent to working group members.

If the user is in a channel associated with a working group, you can omit working_group_slug and it will be inferred from the channel context.

For recurring meetings, use the recurrence parameter with freq, interval, count, and byDay.

Required: title, start_time (ISO format)
Optional: working_group_slug (auto-detected from channel), description, agenda, duration_minutes, timezone, topic_slugs, recurrence

Example prompts this handles:
- "Schedule a technical working group call for next Tuesday at 2pm ET"
- "Set up a bylaws subcommittee meeting for Jan 15 at 3pm PT"
- "Schedule weekly governance calls every Thursday at 3pm for the next 8 weeks"
- "Create a recurring creative WG meeting every other Tuesday at 2pm"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        working_group_slug: {
          type: 'string',
          description: 'Slug of the working group (e.g., "technical", "governance", "creative"). Optional if channel is associated with a working group.',
        },
        title: {
          type: 'string',
          description: 'Meeting title (e.g., "Technical Working Group Call", "Bylaws Review Session")',
        },
        description: {
          type: 'string',
          description: 'Meeting description',
        },
        agenda: {
          type: 'string',
          description: 'Meeting agenda (markdown supported)',
        },
        start_time: {
          type: 'string',
          description: 'Start time in ISO 8601 format (e.g., "2026-01-15T14:00:00")',
        },
        duration_minutes: {
          type: 'number',
          description: 'Duration in minutes (default: 60)',
        },
        timezone: {
          type: 'string',
          description: 'Timezone (default: America/New_York). Examples: America/Los_Angeles, America/Chicago',
        },
        topic_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topic tags for this meeting (only members subscribed to these topics will be invited)',
        },
        recurrence: {
          type: 'object',
          description: 'Recurrence rule for recurring meetings. Omit for one-time meetings.',
          properties: {
            freq: {
              type: 'string',
              enum: ['daily', 'weekly', 'monthly'],
              description: 'Frequency: daily, weekly, or monthly',
            },
            interval: {
              type: 'number',
              description: 'Repeat every N periods (e.g., 2 for every other week). Default: 1',
            },
            by_day: {
              type: 'array',
              items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] },
              description: 'Days of the week for weekly meetings (e.g., ["TU", "TH"] for Tuesdays and Thursdays)',
            },
            count: {
              type: 'number',
              description: 'Total number of meetings to create (e.g., 8 for 8 weeks of meetings)',
            },
          },
          required: ['freq'],
        },
      },
      required: ['title', 'start_time'],
    },
  },
  {
    name: 'list_upcoming_meetings',
    description: `List upcoming meetings. Use this when someone asks about scheduled meetings, what's coming up, or the meeting calendar.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        working_group_slug: {
          type: 'string',
          description: 'Filter by working group slug',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of meetings to return (default: 10)',
        },
      },
    },
  },
  {
    name: 'get_my_meetings',
    description: `Get the user's upcoming meetings. Use this when someone asks "what meetings do I have?" or "what's on my calendar?"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of meetings to return (default: 10)',
        },
      },
    },
  },
  {
    name: 'get_meeting_details',
    description: `Get details about a specific meeting including attendees and RSVP status.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        meeting_id: {
          type: 'string',
          description: 'Meeting ID',
        },
      },
      required: ['meeting_id'],
    },
  },
  {
    name: 'rsvp_to_meeting',
    description: `RSVP to a meeting. Use this when someone says they want to attend a meeting or needs to decline.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        meeting_id: {
          type: 'string',
          description: 'Meeting ID',
        },
        response: {
          type: 'string',
          enum: ['accepted', 'declined', 'tentative'],
          description: 'RSVP response',
        },
        note: {
          type: 'string',
          description: 'Optional note (e.g., "I\'ll be 5 min late")',
        },
      },
      required: ['meeting_id', 'response'],
    },
  },
  {
    name: 'cancel_meeting',
    description: `Cancel a scheduled meeting. Sends cancellation notices to all attendees.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        meeting_id: {
          type: 'string',
          description: 'Meeting ID to cancel',
        },
        reason: {
          type: 'string',
          description: 'Reason for cancellation (optional, included in notice)',
        },
      },
      required: ['meeting_id'],
    },
  },
  {
    name: 'add_meeting_attendee',
    description: `Add someone to a meeting. Use this when someone asks to add a specific person to a scheduled meeting.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        meeting_id: {
          type: 'string',
          description: 'Meeting ID',
        },
        email: {
          type: 'string',
          description: 'Email address of person to add',
        },
        name: {
          type: 'string',
          description: 'Name of person to add',
        },
      },
      required: ['meeting_id', 'email'],
    },
  },
  {
    name: 'update_topic_subscriptions',
    description: `Update meeting topic subscriptions for a user in a working group. Use this when someone wants to change which types of meetings they're invited to.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        working_group_slug: {
          type: 'string',
          description: 'Working group slug',
        },
        topic_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topics to subscribe to (replaces existing subscriptions)',
        },
      },
      required: ['working_group_slug', 'topic_slugs'],
    },
  },
];

/**
 * Meeting tool handler implementations
 */
export function createMeetingToolHandlers(
  memberContext?: MemberContext | null,
  slackUserId?: string,
  threadContext?: ThreadContext | null
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
    if (slackUserId) {
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
    const timezone = (input.timezone as string) || 'America/New_York';
    const recurrenceInput = input.recurrence as { freq: string; interval?: number; by_day?: string[]; count?: number } | undefined;

    // Find working group
    const workingGroup = await workingGroupDb.getWorkingGroupBySlug(workingGroupSlug);
    if (!workingGroup) {
      return `❌ Working group not found: "${workingGroupSlug}". Check the slug and try again.`;
    }

    // Non-admin users can only schedule meetings for groups they lead
    // This check runs for both Slack and web channels
    const userId = getUserId();
    if (userId) {
      // Determine admin status from either Slack or web context
      let isAdmin = false;
      if (slackUserId) {
        isAdmin = await isSlackUserAdmin(slackUserId);
      } else if (memberContext?.org_membership?.role === 'admin') {
        isAdmin = true;
      }

      if (!isAdmin) {
        const isGroupLeader = await workingGroupDb.isLeader(workingGroup.id, userId);
        if (!isGroupLeader) {
          return `⚠️ You can only schedule meetings for committees you lead. You're not a leader of "${workingGroup.name}".`;
        }
      }
    }

    // Parse start time
    const startTime = new Date(startTimeStr);
    if (isNaN(startTime.getTime())) {
      return `❌ Invalid start time format. Please use ISO 8601 format (e.g., "2026-01-15T14:00:00").`;
    }

    // Check if meeting is in the future (comparing in the specified timezone)
    if (!isFutureTimeInTimezone(startTimeStr, timezone)) {
      const nowInTz = getNowInTimezone(timezone);
      return `❌ Meeting time must be in the future. Current time in ${timezone}: ${formatTime(new Date(), timezone)}`;
    }

    const durationMinutes = (input.duration_minutes as number) || 60;

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

        // Extract time from start_time for default_start_time
        const defaultStartTime = `${String(startTime.getHours()).padStart(2, '0')}:${String(startTime.getMinutes()).padStart(2, '0')}:00`;

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
        };

        const series = await meetingsDb.createSeries(seriesInput);
        logger.info({ seriesId: series.id, workingGroupSlug, recurrence: recurrenceRule }, 'Meeting series created');

        // Generate the first batch of meetings
        const meetingsToGenerate = recurrenceInput.count || 4;
        const meetings = await meetingService.generateMeetingsFromSeries(series.id, Math.min(meetingsToGenerate, 8));

        // Build response
        let response = `✅ Created recurring meeting series: **${title}**\n\n`;
        response += `**Working Group:** ${workingGroup.name}\n`;
        response += `**Recurrence:** ${formatRecurrence(recurrenceRule)}\n`;
        response += `**Duration:** ${durationMinutes} minutes\n\n`;

        if (meetings.length > 0) {
          response += `**Scheduled ${meetings.length} meeting${meetings.length > 1 ? 's' : ''}:**\n`;
          for (const meeting of meetings.slice(0, 5)) {
            response += `• ${formatDate(meeting.start_time)} at ${formatTime(meeting.start_time, timezone)}`;
            if (meeting.zoom_join_url) {
              response += ` - [Zoom](${meeting.zoom_join_url})`;
            }
            response += '\n';
          }
          if (meetings.length > 5) {
            response += `• _...and ${meetings.length - 5} more_\n`;
          }
        }

        response += `\n📧 Calendar invites have been sent to working group members.`;

        logger.info({
          seriesId: series.id,
          workingGroupSlug,
          meetingsCreated: meetings.length,
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
      });

      let response = `✅ Scheduled: **${title}**\n\n`;
      response += `**Working Group:** ${workingGroup.name}\n`;
      response += `**When:** ${formatDate(startTime)} at ${formatTime(startTime, timezone)}\n`;
      response += `**Duration:** ${durationMinutes} minutes\n`;

      if (result.meeting.zoom_join_url) {
        response += `**Zoom:** ${result.meeting.zoom_join_url}\n`;
      }

      if (result.errors.length > 0) {
        response += `\n⚠️ Some integrations had issues:\n`;
        response += result.errors.map(e => `• ${e}`).join('\n');
      } else {
        response += `\n📧 Calendar invites have been sent to working group members.`;
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
    const limit = Math.min((input.limit as number) || 10, 20);

    let workingGroupId: string | undefined;
    let groupName: string | undefined;

    if (workingGroupSlug) {
      const group = await workingGroupDb.getWorkingGroupBySlug(workingGroupSlug);
      if (!group) {
        return `❌ Working group not found: "${workingGroupSlug}"`;
      }
      workingGroupId = group.id;
      groupName = group.name;
    }

    const meetings = await meetingsDb.listMeetings({
      working_group_id: workingGroupId,
      upcoming_only: true,
      limit,
    });

    if (meetings.length === 0) {
      let msg = 'No upcoming meetings';
      if (groupName) msg += ` for ${groupName}`;
      return msg + '.';
    }

    let response = `## Upcoming Meetings`;
    if (groupName) response += ` - ${groupName}`;
    response += `\n\n`;

    for (const meeting of meetings) {
      response += `📅 **${meeting.title}**\n`;
      response += `   ${formatDate(meeting.start_time)} at ${formatTime(meeting.start_time, meeting.timezone)}\n`;
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
      response += `   ${formatDate(meeting.start_time)} at ${formatTime(meeting.start_time, meeting.timezone)}\n`;
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
    const meetingId = input.meeting_id as string;

    const meeting = await meetingsDb.getMeetingWithGroup(meetingId);
    if (!meeting) {
      return `❌ Meeting not found: "${meetingId}"`;
    }

    const attendees = await meetingsDb.getAttendeesForMeeting(meetingId);
    const accepted = attendees.filter(a => a.rsvp_status === 'accepted');
    const declined = attendees.filter(a => a.rsvp_status === 'declined');
    const pending = attendees.filter(a => a.rsvp_status === 'pending');

    let response = `## ${meeting.title}\n\n`;
    response += `**Working Group:** ${meeting.working_group_name}\n`;
    response += `**Status:** ${meeting.status}\n`;
    response += `**When:** ${formatDate(meeting.start_time)} at ${formatTime(meeting.start_time, meeting.timezone)}\n`;

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

    const meetingId = input.meeting_id as string;
    const response = input.response as 'accepted' | 'declined' | 'tentative';
    const note = input.note as string | undefined;

    const meeting = await meetingsDb.getMeetingById(meetingId);
    if (!meeting) {
      return `❌ Meeting not found: "${meetingId}"`;
    }

    // Check if user is already an attendee
    let attendee = await meetingsDb.getAttendee(meetingId, userId);

    if (attendee) {
      // Update existing RSVP
      attendee = await meetingsDb.updateAttendee(meetingId, userId, {
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
        meeting_id: meetingId,
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

    const meeting = await meetingsDb.getMeetingById(meetingId);
    if (!meeting) {
      return `❌ Meeting not found: "${meetingId}"`;
    }

    if (meeting.status === 'cancelled') {
      return `Meeting "${meeting.title}" is already cancelled.`;
    }

    try {
      const result = await meetingService.cancelMeeting(meetingId);

      let response = `✅ Cancelled: **${meeting.title}**\n`;
      response += `Cancellation notices have been sent to attendees.`;

      if (result.errors.length > 0) {
        response += `\n\n⚠️ Some cleanup had issues:\n`;
        response += result.errors.map(e => `• ${e}`).join('\n');
      }

      logger.info({ meetingId, cancelledBy: getUserId() }, 'Meeting cancelled via Addie');

      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Failed to cancel meeting: ${msg}`;
    }
  });

  // Add attendee
  handlers.set('add_meeting_attendee', async (input) => {
    const permCheck = await checkSchedulePermission();
    if (permCheck) return permCheck;

    const meetingId = input.meeting_id as string;
    const email = input.email as string;
    const name = input.name as string | undefined;

    const meeting = await meetingsDb.getMeetingById(meetingId);
    if (!meeting) {
      return `❌ Meeting not found: "${meetingId}"`;
    }

    try {
      const result = await meetingService.addAttendeesToMeeting(meetingId, [
        { email, name },
      ]);

      if (result.addedCount > 0) {
        return `✅ Added ${name || email} to **${meeting.title}**. Calendar invite sent.`;
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

  return handlers;
}
