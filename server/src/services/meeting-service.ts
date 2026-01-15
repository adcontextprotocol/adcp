/**
 * Meeting Service
 *
 * Orchestrates meeting creation across:
 * - Database (meetings table)
 * - Zoom (create meeting, get join URL)
 * - Google Calendar (create event, send invites)
 * - Slack (announcements)
 */

import { createLogger } from '../logger.js';
import { MeetingsDatabase } from '../db/meetings-db.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import * as zoom from '../integrations/zoom.js';
import * as calendar from '../integrations/google-calendar.js';
import {
  notifyMeetingStarted,
  notifyMeetingEnded,
} from '../notifications/slack.js';
import type {
  CreateMeetingInput,
  UpdateMeetingInput,
  Meeting,
  MeetingSeries,
  CreateMeetingSeriesInput,
  RecurrenceRule,
} from '../types.js';

const logger = createLogger('meeting-service');

// Host email for Zoom meetings
const ZOOM_HOST_EMAIL = process.env.ZOOM_HOST_EMAIL || 'addie@agenticadvertising.org';

const meetingsDb = new MeetingsDatabase();
const workingGroupDb = new WorkingGroupDatabase();

export interface ScheduleMeetingOptions {
  workingGroupId: string;
  title: string;
  description?: string;
  agenda?: string;
  topicSlugs?: string[];
  startTime: Date;
  durationMinutes?: number;
  timezone?: string;
  seriesId?: string;
  createdByUserId?: string;
  // Control which integrations to use
  createZoomMeeting?: boolean;
  sendCalendarInvites?: boolean;
  announceInSlack?: boolean;
}

export interface ScheduleMeetingResult {
  meeting: Meeting;
  zoomMeeting?: zoom.ZoomMeeting;
  calendarEvent?: calendar.CalendarEvent;
  errors: string[];
}

/**
 * Schedule a new meeting with all integrations
 */
export async function scheduleMeeting(options: ScheduleMeetingOptions): Promise<ScheduleMeetingResult> {
  const errors: string[] = [];

  logger.info({
    title: options.title,
    workingGroupId: options.workingGroupId,
    startTime: options.startTime,
  }, 'Scheduling meeting');

  // Get working group details
  const workingGroup = await workingGroupDb.getWorkingGroupById(options.workingGroupId);
  if (!workingGroup) {
    throw new Error(`Working group not found: ${options.workingGroupId}`);
  }

  const durationMinutes = options.durationMinutes || 60;
  const timezone = options.timezone || 'America/New_York';
  const endTime = new Date(options.startTime.getTime() + durationMinutes * 60 * 1000);

  // Create Zoom meeting
  let zoomMeeting: zoom.ZoomMeeting | undefined;
  if (options.createZoomMeeting !== false && zoom.isZoomConfigured()) {
    try {
      zoomMeeting = await zoom.createMeeting(ZOOM_HOST_EMAIL, {
        topic: `${workingGroup.name}: ${options.title}`,
        start_time: options.startTime.toISOString(),
        duration: durationMinutes,
        timezone,
        agenda: options.agenda || options.description,
        settings: {
          auto_recording: 'cloud',
          waiting_room: false,
          join_before_host: true,
        },
      });
      logger.info({ zoomMeetingId: zoomMeeting.id }, 'Zoom meeting created');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Failed to create Zoom meeting: ${msg}`);
      logger.error({ err: error }, 'Failed to create Zoom meeting');
    }
  }

  // Create meeting in database
  const meetingInput: CreateMeetingInput = {
    series_id: options.seriesId,
    working_group_id: options.workingGroupId,
    title: options.title,
    description: options.description,
    agenda: options.agenda,
    topic_slugs: options.topicSlugs,
    start_time: options.startTime,
    end_time: endTime,
    timezone,
    status: 'scheduled',
    created_by_user_id: options.createdByUserId,
  };

  const meeting = await meetingsDb.createMeeting(meetingInput);

  // Update meeting with Zoom details
  if (zoomMeeting) {
    await meetingsDb.updateMeeting(meeting.id, {
      zoom_meeting_id: String(zoomMeeting.id),
      zoom_join_url: zoomMeeting.join_url,
      zoom_passcode: zoomMeeting.password,
    });
    meeting.zoom_meeting_id = String(zoomMeeting.id);
    meeting.zoom_join_url = zoomMeeting.join_url;
    meeting.zoom_passcode = zoomMeeting.password;
  }

  // Invite working group members to the meeting
  const invitedCount = await meetingsDb.addAttendeesFromGroup(
    meeting.id,
    options.workingGroupId,
    options.topicSlugs
  );
  logger.info({ meetingId: meeting.id, invitedCount }, 'Invited members to meeting');

  // Create Google Calendar event with invites
  let calendarEvent: calendar.CalendarEvent | undefined;
  if (options.sendCalendarInvites !== false && calendar.isGoogleCalendarConfigured()) {
    try {
      // Get attendees from database
      const attendees = await meetingsDb.getAttendeesForMeeting(meeting.id);
      const attendeeEmails = attendees
        .filter(a => a.email)
        .map(a => ({
          email: a.email!,
          displayName: a.name,
        }));

      // Build calendar event
      const eventInput: calendar.CreateCalendarEventInput = {
        summary: `${workingGroup.name}: ${options.title}`,
        description: buildCalendarDescription(options.description, options.agenda, zoomMeeting),
        start: {
          dateTime: options.startTime.toISOString(),
          timeZone: timezone,
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: timezone,
        },
        attendees: attendeeEmails,
        // Set location to Zoom join URL so it appears in calendar invite
        location: zoomMeeting?.join_url,
      };

      // Add Zoom link as conference data
      if (zoomMeeting) {
        eventInput.conferenceData = calendar.createZoomConferenceData(
          zoomMeeting.join_url,
          zoomMeeting.password
        );
      }

      calendarEvent = await calendar.createEvent(eventInput);
      logger.info({ calendarEventId: calendarEvent.id }, 'Calendar event created');

      // Update meeting with calendar event ID
      await meetingsDb.updateMeeting(meeting.id, {
        google_calendar_event_id: calendarEvent.id,
      });
      meeting.google_calendar_event_id = calendarEvent.id;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Failed to create calendar event: ${msg}`);
      logger.error({ err: error }, 'Failed to create calendar event');
    }
  }

  return {
    meeting,
    zoomMeeting,
    calendarEvent,
    errors,
  };
}

/**
 * Cancel a meeting and notify attendees
 */
export async function cancelMeeting(meetingId: string): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  const meeting = await meetingsDb.getMeetingById(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  logger.info({ meetingId, title: meeting.title }, 'Cancelling meeting');

  // Cancel Zoom meeting
  if (meeting.zoom_meeting_id && zoom.isZoomConfigured()) {
    try {
      await zoom.deleteMeeting(meeting.zoom_meeting_id);
      logger.info({ zoomMeetingId: meeting.zoom_meeting_id }, 'Zoom meeting deleted');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Failed to delete Zoom meeting: ${msg}`);
      logger.error({ err: error }, 'Failed to delete Zoom meeting');
    }
  }

  // Delete Google Calendar event (sends cancellation notices)
  if (meeting.google_calendar_event_id && calendar.isGoogleCalendarConfigured()) {
    try {
      await calendar.deleteEvent(meeting.google_calendar_event_id);
      logger.info({ calendarEventId: meeting.google_calendar_event_id }, 'Calendar event deleted');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Failed to delete calendar event: ${msg}`);
      logger.error({ err: error }, 'Failed to delete calendar event');
    }
  }

  // Update meeting status
  await meetingsDb.updateMeeting(meetingId, {
    status: 'cancelled',
  });

  return { success: true, errors };
}

/**
 * Add attendees to an existing meeting
 */
export async function addAttendeesToMeeting(
  meetingId: string,
  attendees: Array<{ email: string; name?: string; workosUserId?: string }>
): Promise<{ addedCount: number; errors: string[] }> {
  const errors: string[] = [];
  let addedCount = 0;

  const meeting = await meetingsDb.getMeetingById(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  // Add to database
  for (const attendee of attendees) {
    try {
      await meetingsDb.addAttendee({
        meeting_id: meetingId,
        workos_user_id: attendee.workosUserId,
        email: attendee.email,
        name: attendee.name,
        invite_source: 'manual',
      });
      addedCount++;
    } catch {
      // Likely duplicate, ignore
    }
  }

  // Add to calendar event
  if (meeting.google_calendar_event_id && calendar.isGoogleCalendarConfigured()) {
    try {
      await calendar.addAttendees(
        meeting.google_calendar_event_id,
        attendees.map(a => ({ email: a.email, displayName: a.name }))
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Failed to add attendees to calendar: ${msg}`);
      logger.error({ err: error }, 'Failed to add attendees to calendar');
    }
  }

  return { addedCount, errors };
}

/**
 * Handle Zoom recording completed webhook
 * Stores transcript and fetches Zoom AI Companion summary
 */
export async function handleRecordingCompleted(meetingUuid: string, zoomMeetingId?: string): Promise<void> {
  logger.info({ meetingUuid, zoomMeetingId }, 'Processing recording completed');

  // Find meeting in database - try zoom_meeting_id first (numeric ID), fall back to UUID lookup
  let meeting: Meeting | null = null;
  if (zoomMeetingId) {
    meeting = await meetingsDb.getMeetingByZoomId(zoomMeetingId);
  }

  if (!meeting) {
    logger.warn({ meetingUuid, zoomMeetingId }, 'Meeting not found in database - transcript will not be stored');
    return;
  }

  // Get transcript
  const transcriptText = await zoom.getTranscriptText(meetingUuid);
  if (transcriptText) {
    // Parse VTT to plain text and store
    const plainText = zoom.parseVttToText(transcriptText);
    logger.info({ meetingId: meeting.id, transcriptLength: plainText.length }, 'Transcript retrieved');

    await meetingsDb.updateMeeting(meeting.id, {
      transcript_text: plainText,
    });
  } else {
    logger.info({ meetingUuid, meetingId: meeting.id }, 'No transcript available');
  }

  // Fetch Zoom AI Companion meeting summary
  try {
    const zoomSummary = await zoom.getMeetingSummary(meetingUuid);
    if (zoomSummary) {
      const summary = zoom.formatMeetingSummaryAsMarkdown(zoomSummary);
      await meetingsDb.updateMeeting(meeting.id, { summary });
      logger.info({ meetingId: meeting.id }, 'Zoom AI Companion summary stored');
    } else {
      logger.info({ meetingId: meeting.id }, 'No Zoom AI Companion summary available');
    }
  } catch (error) {
    logger.error({ err: error, meetingId: meeting.id }, 'Failed to fetch Zoom meeting summary');
  }

  logger.info({ meetingUuid, meetingId: meeting.id }, 'Recording processing completed');
}

/**
 * Build calendar description with meeting details
 */
function buildCalendarDescription(
  description?: string,
  agenda?: string,
  zoomMeeting?: zoom.ZoomMeeting
): string {
  const parts: string[] = [];

  if (description) {
    parts.push(description);
    parts.push('');
  }

  if (agenda) {
    parts.push('Agenda:');
    parts.push(agenda);
    parts.push('');
  }

  if (zoomMeeting) {
    parts.push('Join Zoom Meeting:');
    parts.push(zoomMeeting.join_url);
    if (zoomMeeting.password) {
      parts.push(`Passcode: ${zoomMeeting.password}`);
    }
    parts.push('');
  }

  parts.push('---');
  parts.push('Organized by AgenticAdvertising.org');

  return parts.join('\n');
}

/**
 * Generate upcoming meetings from a series
 */
export async function generateMeetingsFromSeries(
  seriesId: string,
  count: number = 4
): Promise<Meeting[]> {
  const series = await meetingsDb.getSeriesById(seriesId);
  if (!series) {
    throw new Error(`Series not found: ${seriesId}`);
  }

  if (!series.recurrence_rule) {
    throw new Error('Series has no recurrence rule');
  }

  const rule = series.recurrence_rule as RecurrenceRule;
  const meetings: Meeting[] = [];

  // Calculate next occurrence dates
  const dates = calculateNextOccurrences(rule, series.default_start_time, series.timezone, count);

  for (const date of dates) {
    // Check if meeting already exists for this date
    const existing = await meetingsDb.listMeetings({
      series_id: seriesId,
      upcoming_only: true,
    });

    const existingDates = new Set(existing.map(m => m.start_time.toISOString().split('T')[0]));
    const dateStr = date.toISOString().split('T')[0];

    if (existingDates.has(dateStr)) {
      continue; // Skip, already have a meeting for this date
    }

    const result = await scheduleMeeting({
      workingGroupId: series.working_group_id,
      title: series.title,
      description: series.description,
      topicSlugs: series.topic_slugs,
      startTime: date,
      durationMinutes: series.duration_minutes,
      timezone: series.timezone,
      seriesId,
    });

    meetings.push(result.meeting);
  }

  return meetings;
}

/**
 * Calculate next occurrence dates based on recurrence rule
 */
function calculateNextOccurrences(
  rule: RecurrenceRule,
  startTime: string | undefined,
  timezone: string,
  count: number
): Date[] {
  const dates: Date[] = [];
  const now = new Date();

  // Parse start time (e.g., "14:00:00")
  const [hours, minutes] = (startTime || '14:00:00').split(':').map(Number);

  let current = new Date(now);
  current.setHours(hours, minutes, 0, 0);

  // If today's time has passed, start from next occurrence
  if (current <= now) {
    current = getNextOccurrence(current, rule);
  }

  while (dates.length < count) {
    // Check against until date if specified
    if (rule.until && current > new Date(rule.until)) {
      break;
    }

    // Check against count if specified
    if (rule.count && dates.length >= rule.count) {
      break;
    }

    dates.push(new Date(current));
    current = getNextOccurrence(current, rule);
  }

  return dates;
}

/**
 * Get next occurrence based on recurrence rule
 */
function getNextOccurrence(from: Date, rule: RecurrenceRule): Date {
  const next = new Date(from);
  const interval = rule.interval || 1;

  switch (rule.freq) {
    case 'daily':
      next.setDate(next.getDate() + interval);
      break;

    case 'weekly':
      if (rule.byDay && rule.byDay.length > 0) {
        // Find next matching day
        const dayMap: Record<string, number> = {
          SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
        };
        const targetDays = rule.byDay.map(d => dayMap[d]).sort((a, b) => a - b);
        const currentDay = next.getDay();

        // Find next target day
        let found = false;
        for (const targetDay of targetDays) {
          if (targetDay > currentDay) {
            next.setDate(next.getDate() + (targetDay - currentDay));
            found = true;
            break;
          }
        }

        if (!found) {
          // Wrap to next week's first target day
          const daysUntilNextWeek = 7 - currentDay + targetDays[0];
          next.setDate(next.getDate() + daysUntilNextWeek + (interval - 1) * 7);
        }
      } else {
        next.setDate(next.getDate() + interval * 7);
      }
      break;

    case 'monthly':
      next.setMonth(next.getMonth() + interval);
      break;
  }

  return next;
}

/**
 * Handle Zoom meeting started webhook
 * Updates meeting status and sends Slack notification
 */
export async function handleMeetingStarted(zoomMeetingId: string): Promise<void> {
  logger.info({ zoomMeetingId }, 'Processing meeting started');

  const meeting = await meetingsDb.getMeetingByZoomId(zoomMeetingId);
  if (!meeting) {
    logger.warn({ zoomMeetingId }, 'Meeting not found in database - skipping started notification');
    return;
  }

  // Update meeting status
  await meetingsDb.updateMeeting(meeting.id, { status: 'in_progress' });

  // Get working group for Slack channel
  const workingGroup = await workingGroupDb.getWorkingGroupById(meeting.working_group_id);
  if (!workingGroup) {
    logger.warn({ meetingId: meeting.id }, 'Working group not found - skipping Slack notification');
    return;
  }

  // Send Slack notification if channel is configured
  if (workingGroup.slack_channel_id) {
    await notifyMeetingStarted({
      slackChannelId: workingGroup.slack_channel_id,
      meetingTitle: meeting.title,
      workingGroupName: workingGroup.name,
      zoomJoinUrl: meeting.zoom_join_url,
    });
  }

  logger.info({ meetingId: meeting.id, zoomMeetingId }, 'Meeting started processed');
}

/**
 * Handle Zoom meeting ended webhook
 * Updates meeting status and sends Slack notification
 */
export async function handleMeetingEnded(zoomMeetingId: string): Promise<void> {
  logger.info({ zoomMeetingId }, 'Processing meeting ended');

  const meeting = await meetingsDb.getMeetingByZoomId(zoomMeetingId);
  if (!meeting) {
    logger.warn({ zoomMeetingId }, 'Meeting not found in database - skipping ended notification');
    return;
  }

  // Calculate duration if we have start time
  let durationMinutes: number | undefined;
  if (meeting.start_time) {
    const now = new Date();
    durationMinutes = Math.round((now.getTime() - meeting.start_time.getTime()) / 60000);
  }

  // Update meeting status
  await meetingsDb.updateMeeting(meeting.id, {
    status: 'completed',
    end_time: new Date(),
  });

  // Get working group for Slack channel
  const workingGroup = await workingGroupDb.getWorkingGroupById(meeting.working_group_id);
  if (!workingGroup) {
    logger.warn({ meetingId: meeting.id }, 'Working group not found - skipping Slack notification');
    return;
  }

  // Send Slack notification if channel is configured
  if (workingGroup.slack_channel_id) {
    await notifyMeetingEnded({
      slackChannelId: workingGroup.slack_channel_id,
      meetingTitle: meeting.title,
      workingGroupName: workingGroup.name,
      durationMinutes,
    });
  }

  logger.info({ meetingId: meeting.id, zoomMeetingId, durationMinutes }, 'Meeting ended processed');
}
