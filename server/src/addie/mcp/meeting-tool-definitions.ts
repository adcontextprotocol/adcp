// MEETING_TOOLS: the tool definitions of meeting-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

/**
 * Meeting tool definitions
 */
export const MEETING_TOOLS: AddieTool[] = [
  {
    name: 'schedule_meeting',
    description: `Schedule a new working group meeting. Use this when someone asks to schedule a meeting, call, or discussion.
The meeting will be created with a Zoom link. For one-time meetings, calendar invites are sent to working group members by default.

For recurring meetings, calendar invites are sent to working group members by default (same as one-time meetings).

If the user is in a channel associated with a working group, you can omit working_group_slug and it will be inferred from the channel context.

For recurring meetings, use the recurrence parameter with freq, interval, count, and byDay.

Required: title, start_time (RFC 3339 with an explicit offset)
Optional: working_group_slug (auto-detected from channel), description, agenda, duration_minutes, timezone, topic_slugs, recurrence

IMPORTANT: The numeric offset in start_time must agree with timezone at that instant. For example, 2pm New York in January is "2026-01-15T14:00:00-05:00" with timezone "America/New_York". This prevents daylight-saving and server-timezone ambiguity.

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
          format: 'date-time',
          description: 'RFC 3339 start with explicit offset matching timezone, e.g. "2026-01-15T14:00:00-05:00".',
        },
        duration_minutes: {
          type: 'number',
          description: 'Duration in minutes (default: 60)',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone for display/recurrence; defaults to member timezone, then America/New_York.',
        },
        topic_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topic tags for this meeting (used with invite_mode: topic_subscribers)',
        },
        invite_mode: {
          type: 'string',
          enum: ['all_members', 'topic_subscribers', 'slack_channel', 'none'],
          description: 'Who to invite: all_members (default - invite ALL members of the working group, which may be hundreds of people), topic_subscribers (only those subscribed to the topics), slack_channel (invite members of a specific Slack channel - requires invite_slack_channel_id), or none (opt-in - create meeting but let people join themselves)',
        },
        invite_slack_channel_id: {
          type: 'string',
          description: 'Slack channel ID to invite members from (required when invite_mode is slack_channel). Can be found in the channel URL or settings.',
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
    description: `List upcoming meetings. Use this when someone asks about scheduled meetings, what's coming up, or the meeting calendar. Also use this as a first step when you need a meeting_id for add_meeting_attendee, cancel_meeting, or update_meeting. Use my_committees_only to filter to committees the user is a member of.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        working_group_slug: {
          type: 'string',
          description: 'Filter by working group slug',
        },
        my_committees_only: {
          type: 'boolean',
          description: 'If true, only show meetings for committees the user is a member of',
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
    name: 'cancel_meeting_series',
    description: `Cancel a recurring meeting series. Cancels all upcoming meetings in the series (Zoom + calendar) and archives the series record. Use this when someone wants to stop a recurring series entirely.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        series_id: {
          type: 'string',
          description: 'Series ID to cancel. Find this from list_upcoming_meetings or get_meeting_details.',
        },
      },
      required: ['series_id'],
    },
  },
  {
    name: 'update_meeting',
    description: `Update an existing meeting's details. Use this when someone wants to change the time, title, description, or agenda of a scheduled meeting.

This will update the meeting in the database, Zoom (if configured), and Google Calendar.

IMPORTANT: start_time must be RFC 3339 with an explicit offset that agrees with the IANA timezone.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        meeting_id: {
          type: 'string',
          description: 'Meeting ID (UUID or Zoom meeting ID)',
        },
        title: {
          type: 'string',
          description: 'New meeting title',
        },
        description: {
          type: 'string',
          description: 'New meeting description',
        },
        agenda: {
          type: 'string',
          description: 'New meeting agenda (markdown supported)',
        },
        start_time: {
          type: 'string',
          format: 'date-time',
          description: 'RFC 3339 start with explicit offset matching timezone, e.g. "2026-01-15T14:00:00-05:00".',
        },
        duration_minutes: {
          type: 'number',
          description: 'New duration in minutes',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone for start_time. Defaults to the meeting timezone.',
        },
      },
      required: ['meeting_id'],
    },
  },
  {
    name: 'add_meeting_attendee',
    description: `Add a person to an existing meeting by email. Call this once per person. Use list_upcoming_meetings first to get the meeting_id.

Example: "add Karen, Brian, and Jonathan to the call" requires:
1. list_upcoming_meetings to find the meeting_id
2. add_meeting_attendee for Karen
3. add_meeting_attendee for Brian
4. add_meeting_attendee for Jonathan

When add_to_series is true, adds them to all upcoming meetings in the same series.`,
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
        add_to_series: {
          type: 'boolean',
          description: 'If true and the meeting belongs to a recurring series, add the person to all upcoming meetings in the series',
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
  {
    name: 'manage_committee_topics',
    description: `Manage topics for a working group/committee. Topics help organize meetings and filter invitations. Each topic can optionally have its own Slack channel for subgroup discussions. Use action='list' to see current topics, action='add' to create a new topic, action='update' to modify an existing topic, or action='remove' to delete a topic.`,
    usage_hints: 'use when someone wants to add a topic to a working group, update topic channels, or see what topics exist',
    input_schema: {
      type: 'object' as const,
      properties: {
        working_group_slug: {
          type: 'string',
          description: 'Working group slug (e.g., "technical", "governance")',
        },
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove'],
          description: 'Action to perform: list (show topics), add (create new), update (modify), remove (delete)',
        },
        topic_slug: {
          type: 'string',
          description: 'Topic slug for add/update/remove actions',
        },
        topic_name: {
          type: 'string',
          description: 'Display name for the topic (required for add, optional for update)',
        },
        topic_description: {
          type: 'string',
          description: 'Optional description of what this topic covers',
        },
        slack_channel_id: {
          type: 'string',
          description: 'Optional Slack channel ID for this topic (e.g., C09HEERCY8P). Members of this channel can be invited to topic meetings.',
        },
      },
      required: ['working_group_slug', 'action'],
    },
  },
];
