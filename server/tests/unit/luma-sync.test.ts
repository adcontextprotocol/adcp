import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LumaEvent } from '../../src/luma/client.js';

// Mock dependencies before importing the module under test
vi.mock('../../src/db/client.js');
vi.mock('../../src/db/events-db.js');
vi.mock('../../src/luma/client.js');

import * as clientModule from '../../src/db/client.js';
import { eventsDb } from '../../src/db/events-db.js';
import * as lumaClient from '../../src/luma/client.js';
import { createEventFromLuma, syncLumaCalendar } from '../../src/luma/sync.js';

function makeLumaEvent(overrides: Partial<LumaEvent> = {}): LumaEvent {
  return {
    api_id: 'evt_luma_123',
    name: 'AAO Meetup: Amsterdam',
    description: 'The inaugural Amsterdam meetup.',
    cover_url: 'https://images.lumacdn.com/cover.jpg',
    url: 'https://lu.ma/sm6ggl45',
    timezone: 'Europe/Amsterdam',
    start_at: '2026-04-13T17:00:00.000Z',
    end_at: '2026-04-13T19:00:00.000Z',
    duration_interval: null,
    geo_address_json: {
      city: 'Amsterdam',
      region: 'North Holland',
      country: 'Netherlands',
      latitude: 52.3676,
      longitude: 4.9041,
      full_address: 'Amsterdam, Netherlands',
      description: 'TBD Venue',
      place_id: 'place_123',
    },
    geo_latitude: 52.3676,
    geo_longitude: 4.9041,
    meeting_url: null,
    zoom_meeting_url: null,
    visibility: 'public',
    series_api_id: null,
    calendar: {
      api_id: 'cal_aao',
      name: 'AAO Calendar',
    },
    ...overrides,
  };
}

describe('Luma Sync', () => {
  let mockPool: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    vi.mocked(clientModule.getPool).mockReturnValue(mockPool as any);
  });

  describe('createEventFromLuma', () => {
    it('creates an event from a Luma event with correct field mapping', async () => {
      const lumaEvent = makeLumaEvent();

      // No existing event
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // Slug is available
      vi.mocked(eventsDb.isSlugAvailable).mockResolvedValueOnce(true);

      // Return created event
      vi.mocked(eventsDb.createEvent).mockResolvedValueOnce({
        id: 'evt_aao_1',
        slug: 'aao-meetup-amsterdam-2026-04',
      } as any);

      const result = await createEventFromLuma(lumaEvent);

      expect(result).toEqual({ id: 'evt_aao_1', slug: 'aao-meetup-amsterdam-2026-04' });

      // Verify the createEvent call
      const createCall = vi.mocked(eventsDb.createEvent).mock.calls[0][0];
      expect(createCall.title).toBe('AAO Meetup: Amsterdam');
      expect(createCall.luma_event_id).toBe('evt_luma_123');
      expect(createCall.luma_url).toBe('https://lu.ma/sm6ggl45');
      expect(createCall.event_format).toBe('in_person');
      expect(createCall.venue_city).toBe('Amsterdam');
      expect(createCall.venue_country).toBe('Netherlands');
      expect(createCall.venue_lat).toBe(52.3676);
      expect(createCall.venue_lng).toBe(4.9041);
      expect(createCall.status).toBe('published');
      expect(createCall.visibility).toBe('public');
      expect(createCall.timezone).toBe('Europe/Amsterdam');
      expect(createCall.featured_image_url).toBe('https://images.lumacdn.com/cover.jpg');
      expect(createCall.start_time).toEqual(new Date('2026-04-13T17:00:00.000Z'));
      expect(createCall.end_time).toEqual(new Date('2026-04-13T19:00:00.000Z'));
    });

    it('returns null when the event already exists', async () => {
      const lumaEvent = makeLumaEvent();

      // Event already exists
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'evt_aao_1', slug: 'existing-slug' }],
        rowCount: 1,
      });

      const result = await createEventFromLuma(lumaEvent);

      expect(result).toBeNull();
      expect(eventsDb.createEvent).not.toHaveBeenCalled();
    });

    it('appends a suffix when the slug is taken', async () => {
      const lumaEvent = makeLumaEvent();

      // No existing event by luma_event_id
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // First slug taken, second available
      vi.mocked(eventsDb.isSlugAvailable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      vi.mocked(eventsDb.createEvent).mockResolvedValueOnce({
        id: 'evt_aao_1',
        slug: 'aao-meetup-amsterdam-2026-04-1',
      } as any);

      const result = await createEventFromLuma(lumaEvent);

      expect(result).toEqual({ id: 'evt_aao_1', slug: 'aao-meetup-amsterdam-2026-04-1' });

      const createCall = vi.mocked(eventsDb.createEvent).mock.calls[0][0];
      expect(createCall.slug).toBe('aao-meetup-amsterdam-2026-04-1');
    });

    it('maps a virtual Luma event to virtual format', async () => {
      const lumaEvent = makeLumaEvent({
        geo_address_json: null,
        geo_latitude: null,
        geo_longitude: null,
        meeting_url: 'https://zoom.us/j/123',
      });

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      vi.mocked(eventsDb.isSlugAvailable).mockResolvedValueOnce(true);
      vi.mocked(eventsDb.createEvent).mockResolvedValueOnce({ id: 'evt_1', slug: 's' } as any);

      await createEventFromLuma(lumaEvent);

      const createCall = vi.mocked(eventsDb.createEvent).mock.calls[0][0];
      expect(createCall.event_format).toBe('virtual');
      expect(createCall.virtual_url).toBe('https://zoom.us/j/123');
    });

    it('maps a hybrid event (venue + meeting URL)', async () => {
      const lumaEvent = makeLumaEvent({
        zoom_meeting_url: 'https://zoom.us/j/456',
      });

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      vi.mocked(eventsDb.isSlugAvailable).mockResolvedValueOnce(true);
      vi.mocked(eventsDb.createEvent).mockResolvedValueOnce({ id: 'evt_1', slug: 's' } as any);

      await createEventFromLuma(lumaEvent);

      const createCall = vi.mocked(eventsDb.createEvent).mock.calls[0][0];
      expect(createCall.event_format).toBe('hybrid');
    });

    it('maps private Luma events to invite_unlisted visibility', async () => {
      const lumaEvent = makeLumaEvent({ visibility: 'private' });

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      vi.mocked(eventsDb.isSlugAvailable).mockResolvedValueOnce(true);
      vi.mocked(eventsDb.createEvent).mockResolvedValueOnce({ id: 'evt_1', slug: 's' } as any);

      await createEventFromLuma(lumaEvent);

      const createCall = vi.mocked(eventsDb.createEvent).mock.calls[0][0];
      expect(createCall.visibility).toBe('invite_unlisted');
    });
  });

  describe('syncLumaCalendar', () => {
    it('creates events from all calendars', async () => {
      vi.mocked(lumaClient.isLumaEnabled).mockReturnValue(true);

      vi.mocked(lumaClient.listCalendars).mockResolvedValueOnce([
        { api_id: 'cal_1', name: 'AAO Calendar', description: null, cover_url: null, url: 'https://lu.ma/aao' },
      ]);

      vi.mocked(lumaClient.listCalendarEvents).mockResolvedValueOnce([
        makeLumaEvent({ api_id: 'evt_1', name: 'Event 1' }),
        makeLumaEvent({ api_id: 'evt_2', name: 'Event 2' }),
      ]);

      // evt_1 already exists, evt_2 is new
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'existing' }], rowCount: 1 }) // evt_1 exists
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // evt_2 doesn't exist

      vi.mocked(eventsDb.isSlugAvailable).mockResolvedValue(true);
      vi.mocked(eventsDb.createEvent).mockResolvedValue({ id: 'new_evt', slug: 'event-2-2026-04' } as any);

      const stats = await syncLumaCalendar();

      expect(stats.created).toBe(1);
      expect(stats.skipped).toBe(1);
      expect(stats.errors).toBe(0);
    });

    it('returns zeros when Luma is not enabled', async () => {
      vi.mocked(lumaClient.isLumaEnabled).mockReturnValue(false);

      const stats = await syncLumaCalendar();

      expect(stats).toEqual({ created: 0, skipped: 0, errors: 0 });
      expect(lumaClient.listCalendars).not.toHaveBeenCalled();
    });

    it('counts errors without throwing', async () => {
      vi.mocked(lumaClient.isLumaEnabled).mockReturnValue(true);

      vi.mocked(lumaClient.listCalendars).mockResolvedValueOnce([
        { api_id: 'cal_1', name: 'AAO Calendar', description: null, cover_url: null, url: 'https://lu.ma/aao' },
      ]);

      vi.mocked(lumaClient.listCalendarEvents).mockResolvedValueOnce([
        makeLumaEvent({ api_id: 'evt_bad' }),
      ]);

      // Simulate a DB error during creation
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // not existing
      vi.mocked(eventsDb.isSlugAvailable).mockResolvedValueOnce(true);
      vi.mocked(eventsDb.createEvent).mockRejectedValueOnce(new Error('DB connection lost'));

      const stats = await syncLumaCalendar();

      expect(stats.errors).toBe(1);
      expect(stats.created).toBe(0);
    });
  });
});
