/**
 * Google Calendar API Integration
 *
 * Supports two authentication methods:
 * 1. OAuth with refresh token (preferred) - uses Addie's actual Google account
 * 2. Service account with domain-wide delegation - for enterprise setups
 *
 * See: https://developers.google.com/calendar/api/quickstart/nodejs
 */

import { google, calendar_v3 } from 'googleapis';
import { createLogger } from '../logger.js';

const logger = createLogger('google-calendar');

// OAuth credentials (preferred)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Service account credentials (alternative)
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_CALENDAR_IMPERSONATE_EMAIL = process.env.GOOGLE_CALENDAR_IMPERSONATE_EMAIL || 'addie@agenticadvertising.org';

// Calendar client cache
let calendarClient: calendar_v3.Calendar | null = null;

export interface CreateCalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: {
    dateTime: string; // ISO 8601
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
  conferenceData?: {
    entryPoints: Array<{
      entryPointType: string;
      uri: string;
      label?: string;
    }>;
  };
  reminders?: {
    useDefault: boolean;
    overrides?: Array<{
      method: 'email' | 'popup';
      minutes: number;
    }>;
  };
  recurrence?: string[]; // RRULE strings
}

export interface CalendarEvent {
  id: string;
  htmlLink: string;
  summary: string;
  description?: string;
  location?: string;
  start: {
    dateTime?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus: string;
  }>;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType: string;
      uri: string;
      label?: string;
    }>;
  };
}

/**
 * Check if Google Calendar integration is configured
 * Supports both OAuth (preferred) and service account methods
 */
export function isGoogleCalendarConfigured(): boolean {
  // OAuth method (preferred)
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
    return true;
  }
  // Service account method (fallback)
  return !!(GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

/**
 * Get authenticated Calendar client
 * Uses OAuth if available, falls back to service account
 */
async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  if (calendarClient) {
    return calendarClient;
  }

  // Prefer OAuth with refresh token
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({
      refresh_token: GOOGLE_REFRESH_TOKEN,
    });

    calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
    logger.info('Google Calendar client initialized with OAuth');
    return calendarClient;
  }

  // Fall back to service account
  if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    const auth = new google.auth.JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
      subject: GOOGLE_CALENDAR_IMPERSONATE_EMAIL,
    });

    calendarClient = google.calendar({ version: 'v3', auth });
    logger.info({ impersonating: GOOGLE_CALENDAR_IMPERSONATE_EMAIL }, 'Google Calendar client initialized with service account');
    return calendarClient;
  }

  throw new Error('Google Calendar not configured. Set either OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) or service account credentials (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).');
}

/**
 * Create a calendar event with attendees
 * Sends invite emails automatically when sendUpdates is set to 'all'
 */
export async function createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
  const calendar = await getCalendarClient();

  logger.info({
    summary: input.summary,
    attendeeCount: input.attendees?.length || 0,
  }, 'Creating calendar event');

  const event: calendar_v3.Schema$Event = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    attendees: input.attendees?.map(a => ({
      email: a.email,
      displayName: a.displayName,
      optional: a.optional,
    })),
    reminders: input.reminders || {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 }, // 1 day before
        { method: 'popup', minutes: 15 }, // 15 min before
      ],
    },
    recurrence: input.recurrence,
    // Add Zoom link as conference data if provided
    conferenceData: input.conferenceData,
  };

  const response = await calendar.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: input.conferenceData ? 1 : 0,
    sendUpdates: 'all', // Send email invitations to attendees
    requestBody: event,
  });

  const createdEvent = response.data;
  logger.info({
    eventId: createdEvent.id,
    htmlLink: createdEvent.htmlLink,
  }, 'Calendar event created');

  return {
    id: createdEvent.id!,
    htmlLink: createdEvent.htmlLink!,
    summary: createdEvent.summary!,
    description: createdEvent.description || undefined,
    location: createdEvent.location || undefined,
    start: {
      dateTime: createdEvent.start?.dateTime || undefined,
      timeZone: createdEvent.start?.timeZone || undefined,
    },
    end: {
      dateTime: createdEvent.end?.dateTime || undefined,
      timeZone: createdEvent.end?.timeZone || undefined,
    },
    attendees: createdEvent.attendees?.map((a: calendar_v3.Schema$EventAttendee) => ({
      email: a.email!,
      displayName: a.displayName || undefined,
      responseStatus: a.responseStatus!,
    })),
    hangoutLink: createdEvent.hangoutLink || undefined,
    conferenceData: createdEvent.conferenceData ? {
      entryPoints: createdEvent.conferenceData.entryPoints?.map((e: calendar_v3.Schema$EntryPoint) => ({
        entryPointType: e.entryPointType!,
        uri: e.uri!,
        label: e.label || undefined,
      })),
    } : undefined,
  };
}

/**
 * Update a calendar event
 */
export async function updateEvent(
  eventId: string,
  updates: Partial<CreateCalendarEventInput>
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient();

  logger.info({ eventId }, 'Updating calendar event');

  const event: calendar_v3.Schema$Event = {};

  if (updates.summary !== undefined) event.summary = updates.summary;
  if (updates.description !== undefined) event.description = updates.description;
  if (updates.location !== undefined) event.location = updates.location;
  if (updates.start !== undefined) event.start = updates.start;
  if (updates.end !== undefined) event.end = updates.end;
  if (updates.attendees !== undefined) {
    event.attendees = updates.attendees.map(a => ({
      email: a.email,
      displayName: a.displayName,
      optional: a.optional,
    }));
  }

  const response = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    sendUpdates: 'all', // Notify attendees of changes
    requestBody: event,
  });

  const updatedEvent = response.data;
  logger.info({ eventId: updatedEvent.id }, 'Calendar event updated');

  return {
    id: updatedEvent.id!,
    htmlLink: updatedEvent.htmlLink!,
    summary: updatedEvent.summary!,
    description: updatedEvent.description || undefined,
    location: updatedEvent.location || undefined,
    start: {
      dateTime: updatedEvent.start?.dateTime || undefined,
      timeZone: updatedEvent.start?.timeZone || undefined,
    },
    end: {
      dateTime: updatedEvent.end?.dateTime || undefined,
      timeZone: updatedEvent.end?.timeZone || undefined,
    },
    attendees: updatedEvent.attendees?.map((a: calendar_v3.Schema$EventAttendee) => ({
      email: a.email!,
      displayName: a.displayName || undefined,
      responseStatus: a.responseStatus!,
    })),
  };
}

/**
 * Delete a calendar event
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const calendar = await getCalendarClient();

  logger.info({ eventId }, 'Deleting calendar event');

  await calendar.events.delete({
    calendarId: 'primary',
    eventId,
    sendUpdates: 'all', // Send cancellation notices
  });

  logger.info({ eventId }, 'Calendar event deleted');
}

/**
 * Get a calendar event by ID
 */
export async function getEvent(eventId: string): Promise<CalendarEvent | null> {
  const calendar = await getCalendarClient();

  try {
    const response = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const event = response.data;
    return {
      id: event.id!,
      htmlLink: event.htmlLink!,
      summary: event.summary!,
      description: event.description || undefined,
      location: event.location || undefined,
      start: {
        dateTime: event.start?.dateTime || undefined,
        timeZone: event.start?.timeZone || undefined,
      },
      end: {
        dateTime: event.end?.dateTime || undefined,
        timeZone: event.end?.timeZone || undefined,
      },
      attendees: event.attendees?.map((a: calendar_v3.Schema$EventAttendee) => ({
        email: a.email!,
        displayName: a.displayName || undefined,
        responseStatus: a.responseStatus!,
      })),
    };
  } catch (error) {
    logger.error({ err: error, eventId }, 'Failed to get calendar event');
    return null;
  }
}

/**
 * Add attendees to an existing event
 */
export async function addAttendees(
  eventId: string,
  newAttendees: Array<{ email: string; displayName?: string }>
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient();

  // First, get the existing event
  const existing = await calendar.events.get({
    calendarId: 'primary',
    eventId,
  });

  const currentAttendees = existing.data.attendees || [];
  const currentEmails = new Set(currentAttendees.map((a: calendar_v3.Schema$EventAttendee) => a.email?.toLowerCase()));

  // Add only new attendees (avoid duplicates)
  const attendeesToAdd = newAttendees.filter(
    a => !currentEmails.has(a.email.toLowerCase())
  );

  if (attendeesToAdd.length === 0) {
    logger.info({ eventId }, 'No new attendees to add');
    return {
      id: existing.data.id!,
      htmlLink: existing.data.htmlLink!,
      summary: existing.data.summary!,
      start: { dateTime: existing.data.start?.dateTime || undefined },
      end: { dateTime: existing.data.end?.dateTime || undefined },
      attendees: currentAttendees.map((a: calendar_v3.Schema$EventAttendee) => ({
        email: a.email!,
        displayName: a.displayName || undefined,
        responseStatus: a.responseStatus!,
      })),
    };
  }

  const allAttendees = [
    ...currentAttendees,
    ...attendeesToAdd.map(a => ({
      email: a.email,
      displayName: a.displayName,
    })),
  ];

  logger.info({
    eventId,
    newAttendeeCount: attendeesToAdd.length,
  }, 'Adding attendees to calendar event');

  const response = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    sendUpdates: 'all',
    requestBody: {
      attendees: allAttendees,
    },
  });

  return {
    id: response.data.id!,
    htmlLink: response.data.htmlLink!,
    summary: response.data.summary!,
    start: { dateTime: response.data.start?.dateTime || undefined },
    end: { dateTime: response.data.end?.dateTime || undefined },
    attendees: response.data.attendees?.map((a: calendar_v3.Schema$EventAttendee) => ({
      email: a.email!,
      displayName: a.displayName || undefined,
      responseStatus: a.responseStatus!,
    })),
  };
}

/**
 * Convert recurrence rule to Google Calendar RRULE format
 */
export function formatRecurrenceRule(rule: {
  freq: 'daily' | 'weekly' | 'monthly';
  interval?: number;
  byDay?: string[];
  count?: number;
  until?: string;
}): string[] {
  const parts: string[] = [`FREQ=${rule.freq.toUpperCase()}`];

  if (rule.interval && rule.interval > 1) {
    parts.push(`INTERVAL=${rule.interval}`);
  }

  if (rule.byDay && rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.join(',')}`);
  }

  if (rule.count) {
    parts.push(`COUNT=${rule.count}`);
  } else if (rule.until) {
    // Convert ISO date to RRULE format (YYYYMMDDTHHMMSSZ)
    const until = new Date(rule.until).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    parts.push(`UNTIL=${until}`);
  }

  return [`RRULE:${parts.join(';')}`];
}

/**
 * Create conference data for Zoom meeting
 */
export function createZoomConferenceData(joinUrl: string, passcode?: string): CreateCalendarEventInput['conferenceData'] {
  const entryPoints: Array<{ entryPointType: string; uri: string; label?: string }> = [
    {
      entryPointType: 'video',
      uri: joinUrl,
      label: 'Join Zoom Meeting',
    },
  ];

  return { entryPoints };
}
