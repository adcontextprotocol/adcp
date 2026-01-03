import { createLogger } from '../logger.js';

const logger = createLogger('luma-client');

// Initialize Luma API client
const LUMA_API_KEY = process.env.LUMA_API_KEY;
const LUMA_API_BASE = 'https://api.lu.ma/public/v1';

if (!LUMA_API_KEY) {
  logger.warn('LUMA_API_KEY not set - event features will be disabled');
}

// ============================================================================
// Types
// ============================================================================

export interface LumaEvent {
  api_id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  url: string;
  timezone: string;
  start_at: string; // ISO 8601
  end_at: string; // ISO 8601
  duration_interval: string | null;
  geo_address_json: {
    city: string;
    region: string;
    country: string;
    latitude: number;
    longitude: number;
    full_address: string;
    description: string;
    place_id: string;
  } | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  meeting_url: string | null;
  zoom_meeting_url: string | null;
  visibility: 'public' | 'private';
  series_api_id: string | null;
  calendar: {
    api_id: string;
    name: string;
  } | null;
}

export interface LumaGuest {
  api_id: string;
  event_api_id: string;
  user_api_id: string | null;
  user_name: string | null;
  user_email: string;
  approval_status: 'approved' | 'pending_approval' | 'declined' | 'invited';
  created_at: string;
  updated_at: string;
  registered_at: string | null;
  checked_in_at: string | null;
  registration_answers: Record<string, string> | null;
}

export interface CreateEventInput {
  name: string;
  description?: string;
  start_at: string; // ISO 8601 datetime
  end_at: string; // ISO 8601 datetime
  timezone?: string; // e.g. 'America/New_York'
  geo_address_json?: {
    city?: string;
    region?: string;
    country?: string;
    full_address?: string;
    description?: string;
  };
  meeting_url?: string; // For virtual events
  cover_url?: string;
  visibility?: 'public' | 'private';
  require_rsvp_approval?: boolean;
}

export interface UpdateEventInput {
  name?: string;
  description?: string;
  start_at?: string;
  end_at?: string;
  timezone?: string;
  geo_address_json?: {
    city?: string;
    region?: string;
    country?: string;
    full_address?: string;
    description?: string;
  };
  meeting_url?: string;
  cover_url?: string;
  visibility?: 'public' | 'private';
}

// ============================================================================
// API Client
// ============================================================================

async function lumaFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  if (!LUMA_API_KEY) {
    throw new Error('LUMA_API_KEY not configured');
  }

  const url = `${LUMA_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'x-luma-api-key': LUMA_API_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({
      endpoint,
      status: response.status,
      statusText: response.statusText,
      error: errorText,
    }, 'Luma API request failed');
    throw new Error(`Luma API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Event Operations
// ============================================================================

/**
 * Check if Luma integration is enabled
 */
export function isLumaEnabled(): boolean {
  return !!LUMA_API_KEY;
}

/**
 * Create a new event in Luma
 */
export async function createEvent(input: CreateEventInput): Promise<LumaEvent> {
  logger.info({ name: input.name, start_at: input.start_at }, 'Creating Luma event');

  const response = await lumaFetch<{ event: LumaEvent }>('/event/create', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  logger.info({
    eventId: response.event.api_id,
    url: response.event.url,
  }, 'Created Luma event');

  return response.event;
}

/**
 * Get event details by ID
 */
export async function getEvent(eventId: string): Promise<LumaEvent | null> {
  try {
    const response = await lumaFetch<{ event: LumaEvent }>(`/event/get?api_id=${encodeURIComponent(eventId)}`);
    return response.event;
  } catch (error) {
    logger.error({ err: error, eventId }, 'Error fetching Luma event');
    return null;
  }
}

/**
 * Update an existing event
 */
export async function updateEvent(eventId: string, input: UpdateEventInput): Promise<LumaEvent | null> {
  try {
    logger.info({ eventId, updates: Object.keys(input) }, 'Updating Luma event');

    const response = await lumaFetch<{ event: LumaEvent }>('/event/update', {
      method: 'POST',
      body: JSON.stringify({
        api_id: eventId,
        ...input,
      }),
    });

    logger.info({ eventId }, 'Updated Luma event');
    return response.event;
  } catch (error) {
    logger.error({ err: error, eventId }, 'Error updating Luma event');
    return null;
  }
}

/**
 * Delete an event (cancel it in Luma)
 */
export async function deleteEvent(eventId: string): Promise<boolean> {
  try {
    logger.info({ eventId }, 'Deleting Luma event');

    await lumaFetch('/event/delete', {
      method: 'POST',
      body: JSON.stringify({ api_id: eventId }),
    });

    logger.info({ eventId }, 'Deleted Luma event');
    return true;
  } catch (error) {
    logger.error({ err: error, eventId }, 'Error deleting Luma event');
    return false;
  }
}

// ============================================================================
// Guest/Registration Operations
// ============================================================================

/**
 * Get all guests/registrations for an event
 */
export async function getEventGuests(eventId: string): Promise<LumaGuest[]> {
  try {
    const guests: LumaGuest[] = [];
    let cursor: string | null = null;

    // Paginate through all guests
    do {
      const urlParams = new URLSearchParams({
        event_api_id: eventId,
        ...(cursor && { pagination_cursor: cursor }),
      });

      const response: {
        entries: Array<{ guest: LumaGuest }>;
        has_more: boolean;
        next_cursor: string | null;
      } = await lumaFetch(`/event/get-guests?${urlParams}`);

      for (const entry of response.entries) {
        guests.push(entry.guest);
      }

      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);

    logger.debug({ eventId, count: guests.length }, 'Fetched Luma event guests');
    return guests;
  } catch (error) {
    logger.error({ err: error, eventId }, 'Error fetching Luma event guests');
    return [];
  }
}

/**
 * Get a single guest registration
 */
export async function getGuest(guestId: string): Promise<LumaGuest | null> {
  try {
    const response = await lumaFetch<{ guest: LumaGuest }>(`/event/get-guest?api_id=${encodeURIComponent(guestId)}`);
    return response.guest;
  } catch (error) {
    logger.error({ err: error, guestId }, 'Error fetching Luma guest');
    return null;
  }
}

/**
 * Approve a guest registration (for events requiring approval)
 */
export async function approveGuest(guestId: string): Promise<boolean> {
  try {
    await lumaFetch('/event/manage-guest', {
      method: 'POST',
      body: JSON.stringify({
        api_id: guestId,
        approval_status: 'approved',
      }),
    });
    logger.info({ guestId }, 'Approved Luma guest');
    return true;
  } catch (error) {
    logger.error({ err: error, guestId }, 'Error approving Luma guest');
    return false;
  }
}

/**
 * Decline a guest registration
 */
export async function declineGuest(guestId: string): Promise<boolean> {
  try {
    await lumaFetch('/event/manage-guest', {
      method: 'POST',
      body: JSON.stringify({
        api_id: guestId,
        approval_status: 'declined',
      }),
    });
    logger.info({ guestId }, 'Declined Luma guest');
    return true;
  } catch (error) {
    logger.error({ err: error, guestId }, 'Error declining Luma guest');
    return false;
  }
}

/**
 * Check in a guest at an event
 */
export async function checkInGuest(guestId: string): Promise<boolean> {
  try {
    await lumaFetch('/event/check-in-guest', {
      method: 'POST',
      body: JSON.stringify({ api_id: guestId }),
    });
    logger.info({ guestId }, 'Checked in Luma guest');
    return true;
  } catch (error) {
    logger.error({ err: error, guestId }, 'Error checking in Luma guest');
    return false;
  }
}

// ============================================================================
// Calendar Operations
// ============================================================================

export interface LumaCalendar {
  api_id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  url: string;
}

/**
 * List all calendars accessible to the API key
 */
export async function listCalendars(): Promise<LumaCalendar[]> {
  try {
    const response = await lumaFetch<{ entries: Array<{ calendar: LumaCalendar }> }>('/calendar/list-calendars');
    return response.entries.map((entry) => entry.calendar);
  } catch (error) {
    logger.error({ err: error }, 'Error listing Luma calendars');
    return [];
  }
}

/**
 * List events from a calendar
 */
export async function listCalendarEvents(
  calendarId: string,
  options: { after?: string; before?: string } = {}
): Promise<LumaEvent[]> {
  try {
    const events: LumaEvent[] = [];
    let cursor: string | null = null;

    do {
      const urlParams = new URLSearchParams({
        calendar_api_id: calendarId,
        ...(options.after && { after: options.after }),
        ...(options.before && { before: options.before }),
        ...(cursor && { pagination_cursor: cursor }),
      });

      const response: {
        entries: Array<{ event: LumaEvent }>;
        has_more: boolean;
        next_cursor: string | null;
      } = await lumaFetch(`/calendar/list-events?${urlParams}`);

      for (const entry of response.entries) {
        events.push(entry.event);
      }

      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);

    logger.debug({ calendarId, count: events.length }, 'Fetched calendar events');
    return events;
  } catch (error) {
    logger.error({ err: error, calendarId }, 'Error listing calendar events');
    return [];
  }
}

// ============================================================================
// Webhook Verification
// ============================================================================

export interface LumaWebhookPayload {
  action: 'event.created' | 'event.updated' | 'event.deleted' | 'guest.created' | 'guest.updated';
  data: {
    api_id: string;
    event?: LumaEvent;
    guest?: LumaGuest;
  };
}

/**
 * Parse and validate a Luma webhook payload
 * Note: Luma webhooks don't have signature verification by default
 * Consider validating the payload structure
 */
export function parseWebhookPayload(body: unknown): LumaWebhookPayload | null {
  if (!body || typeof body !== 'object') {
    logger.warn({ body }, 'Invalid webhook payload: not an object');
    return null;
  }

  const payload = body as Record<string, unknown>;

  if (!payload.action || typeof payload.action !== 'string') {
    logger.warn({ payload }, 'Invalid webhook payload: missing action');
    return null;
  }

  if (!payload.data || typeof payload.data !== 'object') {
    logger.warn({ payload }, 'Invalid webhook payload: missing data');
    return null;
  }

  const validActions = ['event.created', 'event.updated', 'event.deleted', 'guest.created', 'guest.updated'];
  if (!validActions.includes(payload.action)) {
    logger.warn({ action: payload.action }, 'Unknown webhook action');
    return null;
  }

  return payload as unknown as LumaWebhookPayload;
}
