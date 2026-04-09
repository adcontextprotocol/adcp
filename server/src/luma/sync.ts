/**
 * Luma → AAO Event Sync
 *
 * Creates AAO events from Luma events. Used by:
 * - Webhook handler (event.created, event.updated for unknown events)
 * - Periodic calendar poll (safety net for missed webhooks)
 */

import { createLogger } from '../logger.js';
import { eventsDb } from '../db/events-db.js';
import { getPool } from '../db/client.js';
import {
  listCalendars,
  listCalendarEvents,
  isLumaEnabled,
  type LumaEvent,
} from './client.js';
import type { CreateEventInput, EventFormat, EventVisibility } from '../types.js';

const logger = createLogger('luma-sync');

// Calendar ID can be configured via env var (avoids needing list-calendars permission)
const LUMA_CALENDAR_ID = process.env.LUMA_CALENDAR_ID;

/**
 * Generate a URL-friendly slug from a Luma event name and start date.
 */
function generateSlug(name: string, startAt: string): string {
  const date = new Date(startAt);
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  return `${slug}-${dateStr}`;
}

/**
 * Determine event format from Luma event fields.
 */
function inferEventFormat(lumaEvent: LumaEvent): EventFormat {
  const hasVenue = !!lumaEvent.geo_address_json;
  const hasVirtual = !!(lumaEvent.meeting_url || lumaEvent.zoom_meeting_url);

  if (hasVenue && hasVirtual) return 'hybrid';
  if (hasVirtual) return 'virtual';
  return 'in_person';
}

/**
 * Map Luma visibility to AAO visibility.
 * Private Luma events become invite_unlisted (hidden from public listings).
 */
function mapVisibility(lumaVisibility: LumaEvent['visibility']): EventVisibility {
  return lumaVisibility === 'private' ? 'invite_unlisted' : 'public';
}

/**
 * Create an AAO event from a Luma event.
 * Returns the created event, or null if the event already exists.
 */
export async function createEventFromLuma(lumaEvent: LumaEvent): Promise<{ id: string; slug: string } | null> {
  // Check if we already have this event
  const pool = getPool();
  const existing = await pool.query(
    'SELECT id, slug FROM events WHERE luma_event_id = $1',
    [lumaEvent.api_id]
  );

  if (existing.rows.length > 0) {
    logger.debug({ lumaEventId: lumaEvent.api_id }, 'Event already exists, skipping');
    return null;
  }

  const slug = generateSlug(lumaEvent.name, lumaEvent.start_at);

  // Ensure slug uniqueness by appending a suffix if needed
  let finalSlug = slug;
  let attempt = 0;
  while (!(await eventsDb.isSlugAvailable(finalSlug))) {
    attempt++;
    finalSlug = `${slug}-${attempt}`;
  }

  // Past events get 'completed' status, future events get 'published'
  const endTime = new Date(lumaEvent.end_at);
  const isPast = endTime < new Date();

  const eventInput: CreateEventInput = {
    slug: finalSlug,
    title: lumaEvent.name,
    description: lumaEvent.description || undefined,
    event_type: 'meetup',
    event_format: inferEventFormat(lumaEvent),
    start_time: new Date(lumaEvent.start_at),
    end_time: endTime,
    timezone: lumaEvent.timezone,
    venue_name: lumaEvent.geo_address_json?.description || undefined,
    venue_address: lumaEvent.geo_address_json?.full_address || undefined,
    venue_city: lumaEvent.geo_address_json?.city || undefined,
    venue_state: lumaEvent.geo_address_json?.region || undefined,
    venue_country: lumaEvent.geo_address_json?.country || undefined,
    venue_lat: lumaEvent.geo_address_json?.latitude || lumaEvent.geo_latitude || undefined,
    venue_lng: lumaEvent.geo_address_json?.longitude || lumaEvent.geo_longitude || undefined,
    virtual_url: lumaEvent.meeting_url || lumaEvent.zoom_meeting_url || undefined,
    luma_event_id: lumaEvent.api_id,
    luma_url: lumaEvent.url,
    featured_image_url: lumaEvent.cover_url || undefined,
    status: isPast ? 'completed' : 'published',
    visibility: mapVisibility(lumaEvent.visibility),
    metadata: {
      synced_from_luma: true,
      luma_calendar: lumaEvent.calendar?.name || null,
    },
  };

  const event = await eventsDb.createEvent(eventInput);

  logger.info({
    eventId: event.id,
    slug: finalSlug,
    lumaEventId: lumaEvent.api_id,
    title: lumaEvent.name,
  }, 'Created event from Luma');

  return { id: event.id, slug: finalSlug };
}

// ============================================================================
// Calendar Polling
// ============================================================================

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Sync events from a single Luma calendar to AAO.
 * Fetches all events (past and future) so we capture the full event history.
 */
async function syncCalendar(calendarId: string, stats: { created: number; skipped: number; errors: number }): Promise<void> {
  // Fetch all events — no after/before filter
  const events = await listCalendarEvents(calendarId);

  logger.info({ calendarId, eventCount: events.length }, 'Fetched calendar events');

  for (const lumaEvent of events) {
    try {
      const result = await createEventFromLuma(lumaEvent);
      if (result) {
        stats.created++;
      } else {
        stats.skipped++;
      }
    } catch (err) {
      stats.errors++;
      logger.error({ err, lumaEventId: lumaEvent.api_id, name: lumaEvent.name }, 'Failed to sync Luma event');
    }
  }
}

/**
 * Sync all events from Luma calendars to AAO.
 * Uses LUMA_CALENDAR_ID if configured, otherwise discovers calendars via API.
 */
export async function syncLumaCalendar(): Promise<{ created: number; skipped: number; errors: number }> {
  if (!isLumaEnabled()) {
    logger.debug('Luma not enabled, skipping calendar sync');
    return { created: 0, skipped: 0, errors: 0 };
  }

  const stats = { created: 0, skipped: 0, errors: 0 };

  try {
    if (LUMA_CALENDAR_ID) {
      // Use configured calendar ID directly
      logger.info({ calendarId: LUMA_CALENDAR_ID }, 'Syncing configured Luma calendar');
      await syncCalendar(LUMA_CALENDAR_ID, stats);
    } else {
      // Discover calendars via API
      const calendars = await listCalendars();
      logger.info({ calendarCount: calendars.length }, 'Syncing discovered Luma calendars');

      for (const calendar of calendars) {
        try {
          await syncCalendar(calendar.api_id, stats);
        } catch (err) {
          stats.errors++;
          logger.error({ err, calendarId: calendar.api_id }, 'Failed to sync calendar');
        }
      }
    }
  } catch (err) {
    stats.errors++;
    logger.error({ err }, 'Failed to sync Luma calendars');
  }

  logger.info(stats, 'Luma calendar sync complete');
  return stats;
}

/**
 * Start periodic Luma calendar sync.
 */
export function startLumaSync(): void {
  if (intervalId) return;
  if (!isLumaEnabled()) {
    logger.info('Luma not enabled, skipping sync startup');
    return;
  }

  // Run immediately on startup, then hourly
  syncLumaCalendar().catch(err => logger.error({ err }, 'Luma calendar sync failed'));

  intervalId = setInterval(() => {
    syncLumaCalendar().catch(err => logger.error({ err }, 'Luma calendar sync failed'));
  }, SYNC_INTERVAL_MS);

  logger.info({ intervalMs: SYNC_INTERVAL_MS }, 'Started Luma calendar sync');
}

/**
 * Stop periodic Luma calendar sync.
 */
export function stopLumaSync(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Stopped Luma calendar sync');
  }
}
