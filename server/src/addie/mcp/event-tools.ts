/**
 * Addie Event Tools
 *
 * Tools for event management through natural conversation.
 * Enables committee leads and admins to create and manage events via Slack.
 *
 * Event creation flow:
 * 1. User describes the event they want to create
 * 2. Addie uses create_event tool to create in Luma + AAO database
 * 3. Addie posts announcement to appropriate Slack channel
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { isSlackUserAAOAdmin } from './admin-tools.js';
import { eventsDb } from '../../db/events-db.js';
import { upsertEmailContact } from '../../db/contacts-db.js';
import { query } from '../../db/client.js';
import {
  createEvent as createLumaEvent,
  updateEvent as updateLumaEvent,
  getEvent as getLumaEvent,
  getEventGuests,
  approveGuest,
  declineGuest,
  isLumaEnabled,
  type CreateEventInput as LumaCreateEventInput,
  type UpdateEventInput as LumaUpdateEventInput,
} from '../../luma/client.js';
import type {
  CreateEventInput,
  EventType,
  EventFormat,
  Event,
} from '../../types.js';

const logger = createLogger('addie-event-tools');

// Committee slugs whose leads can create events
const EVENT_CREATOR_COMMITTEES = ['marketing', 'education', 'aao-admin'];

/**
 * Result from getting personalized events for a user
 */
interface PersonalizedEventsResult {
  events: Event[];
  userLocation: { city: string | null; country: string | null };
  missingLocation: boolean;
  industryGatherings: Array<{ name: string; eventDate: Date | null }>;
  chapters: Array<{ name: string; region: string | null }>;
}

/**
 * Get events personalized for a specific user.
 *
 * Returns:
 * - Events the user is registered for
 * - Events in regional chapters the user is a member of
 * - Events at industry gatherings the user is interested in
 * - Major global summits (open to all)
 *
 * Excludes virtual webinars (those belong in education).
 */
async function getPersonalizedEvents(
  workosUserId?: string,
  slackUserId?: string,
  includePast = false,
  userEmail?: string,
): Promise<PersonalizedEventsResult> {
  const result: PersonalizedEventsResult = {
    events: [],
    userLocation: { city: null, country: null },
    missingLocation: true,
    industryGatherings: [],
    chapters: [],
  };

  // Get user location
  if (slackUserId) {
    const locationQuery = await query<{ city: string | null; country: string | null }>(
      `SELECT u.city, u.country
       FROM slack_user_mappings sm
       JOIN users u ON u.workos_user_id = sm.workos_user_id
       WHERE sm.slack_user_id = $1
       LIMIT 1`,
      [slackUserId]
    );
    if (locationQuery.rows[0]) {
      result.userLocation = locationQuery.rows[0];
      result.missingLocation = !locationQuery.rows[0].city;
    }
  }

  // Get user's industry gatherings and chapters
  if (workosUserId) {
    const [gatheringsQuery, chaptersQuery] = await Promise.all([
      query<{ name: string; event_start_date: Date | null }>(
        `SELECT wg.name, wg.event_start_date
         FROM working_group_memberships wgm
         JOIN working_groups wg ON wg.id = wgm.working_group_id
         WHERE wgm.workos_user_id = $1
           AND wg.committee_type = 'industry_gathering'
           AND wg.status = 'active'
           AND wgm.status = 'active'
           AND wgm.interest_level IN ('attending', 'interested')
           AND (wg.event_end_date IS NULL OR wg.event_end_date >= CURRENT_DATE)`,
        [workosUserId]
      ),
      query<{ name: string; region: string | null }>(
        `SELECT wg.name, wg.region
         FROM working_group_memberships wgm
         JOIN working_groups wg ON wg.id = wgm.working_group_id
         WHERE wgm.workos_user_id = $1
           AND wg.committee_type = 'chapter'
           AND wg.status = 'active'
           AND wgm.status = 'active'`,
        [workosUserId]
      ),
    ]);

    result.industryGatherings = gatheringsQuery.rows.map(r => ({
      name: r.name,
      eventDate: r.event_start_date,
    }));
    result.chapters = chaptersQuery.rows.map(r => ({
      name: r.name,
      region: r.region,
    }));
  }

  // Build queries for personalized events - separate queries for upcoming vs past to avoid SQL interpolation
  const eventIds: Set<string> = new Set();

  // 1. Events user is registered for (match by workos_user_id OR email for Luma-synced registrations)
  if (workosUserId || userEmail) {
    const whereClause = workosUserId && userEmail
      ? `(er.workos_user_id = $1 OR LOWER(er.email) = LOWER($2))`
      : workosUserId
        ? `er.workos_user_id = $1`
        : `LOWER(er.email) = LOWER($1)`;
    const params = workosUserId && userEmail
      ? [workosUserId, userEmail]
      : [workosUserId || userEmail];

    const registeredEvents = includePast
      ? await query<Event>(
          `SELECT DISTINCT e.* FROM events e
           JOIN event_registrations er ON er.event_id = e.id
           WHERE ${whereClause}
             AND er.registration_status IN ('registered', 'waitlisted')
             AND e.status IN ('published', 'completed')
             AND e.start_time < NOW()
             AND e.event_format != 'virtual'
           ORDER BY e.start_time DESC`,
          params
        )
      : await query<Event>(
          `SELECT DISTINCT e.* FROM events e
           JOIN event_registrations er ON er.event_id = e.id
           WHERE ${whereClause}
             AND er.registration_status IN ('registered', 'waitlisted')
             AND e.status IN ('published', 'completed')
             AND e.start_time > NOW()
             AND e.event_format != 'virtual'
           ORDER BY e.start_time ASC`,
          params
        );
    for (const event of registeredEvents.rows) {
      if (!eventIds.has(event.id)) {
        eventIds.add(event.id);
        result.events.push(event);
      }
    }
  }

  // 2. Events at industry gatherings user is interested in
  if (result.industryGatherings.length > 0 && workosUserId) {
    const gatheringEvents = includePast
      ? await query<Event>(
          `SELECT DISTINCT e.* FROM events e
           JOIN working_groups wg ON wg.linked_event_id = e.id
           JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
           WHERE wgm.workos_user_id = $1
             AND wg.committee_type = 'industry_gathering'
             AND wgm.status = 'active'
             AND wgm.interest_level IN ('attending', 'interested')
             AND e.status IN ('published', 'completed')
             AND e.start_time < NOW()
             AND e.event_format != 'virtual'
           ORDER BY e.start_time DESC`,
          [workosUserId]
        )
      : await query<Event>(
          `SELECT DISTINCT e.* FROM events e
           JOIN working_groups wg ON wg.linked_event_id = e.id
           JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
           WHERE wgm.workos_user_id = $1
             AND wg.committee_type = 'industry_gathering'
             AND wgm.status = 'active'
             AND wgm.interest_level IN ('attending', 'interested')
             AND e.status IN ('published', 'completed')
             AND e.start_time > NOW()
             AND e.event_format != 'virtual'
           ORDER BY e.start_time ASC`,
          [workosUserId]
        );
    for (const event of gatheringEvents.rows) {
      if (!eventIds.has(event.id)) {
        eventIds.add(event.id);
        result.events.push(event);
      }
    }
  }

  // 3. Events in regional chapters user is a member of (single query for all regions)
  if (result.chapters.length > 0) {
    const chapterRegions = result.chapters
      .map(c => c.region)
      .filter((r): r is string => r !== null);

    if (chapterRegions.length > 0) {
      // Use ANY() to match any chapter region in a single query
      const chapterEvents = includePast
        ? await query<Event>(
            `SELECT DISTINCT e.* FROM events e
             WHERE e.status IN ('published', 'completed')
               AND e.start_time < NOW()
               AND e.event_format != 'virtual'
               AND EXISTS (
                 SELECT 1 FROM unnest($1::text[]) AS region
                 WHERE LOWER(e.venue_city) LIKE '%' || LOWER(region) || '%'
                    OR LOWER(region) LIKE '%' || LOWER(COALESCE(e.venue_city, '')) || '%'
               )
             ORDER BY e.start_time DESC
             LIMIT 20`,
            [chapterRegions]
          )
        : await query<Event>(
            `SELECT DISTINCT e.* FROM events e
             WHERE e.status IN ('published', 'completed')
               AND e.start_time > NOW()
               AND e.event_format != 'virtual'
               AND EXISTS (
                 SELECT 1 FROM unnest($1::text[]) AS region
                 WHERE LOWER(e.venue_city) LIKE '%' || LOWER(region) || '%'
                    OR LOWER(region) LIKE '%' || LOWER(COALESCE(e.venue_city, '')) || '%'
               )
             ORDER BY e.start_time ASC
             LIMIT 20`,
            [chapterRegions]
          );
      for (const event of chapterEvents.rows) {
        if (!eventIds.has(event.id)) {
          eventIds.add(event.id);
          result.events.push(event);
        }
      }
    }
  }

  // 4. Major global summits (open to all)
  const summits = includePast
    ? await query<Event>(
        `SELECT * FROM events
         WHERE status IN ('published', 'completed')
           AND start_time < NOW()
           AND event_type = 'summit'
           AND event_format != 'virtual'
         ORDER BY start_time DESC
         LIMIT 5`
      )
    : await query<Event>(
        `SELECT * FROM events
         WHERE status IN ('published', 'completed')
           AND start_time > NOW()
           AND event_type = 'summit'
           AND event_format != 'virtual'
         ORDER BY start_time ASC
         LIMIT 5`
      );
  for (const event of summits.rows) {
    if (!eventIds.has(event.id)) {
      eventIds.add(event.id);
      result.events.push(event);
    }
  }

  // Sort final list by date
  result.events.sort((a, b) => {
    const aTime = new Date(a.start_time).getTime();
    const bTime = new Date(b.start_time).getTime();
    return includePast ? bTime - aTime : aTime - bTime;
  });

  return result;
}

/**
 * Check if a Slack user can create events
 * Must be an admin or lead of marketing/education committees
 */
export async function canCreateEvents(slackUserId: string): Promise<boolean> {
  // Admins can always create events
  const isAdmin = await isSlackUserAAOAdmin(slackUserId);
  if (isAdmin) return true;

  // TODO: Check committee membership when that's implemented
  // For now, only admins can create events
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an event from any user-facing identifier: internal slug, internal
 * UUID, Luma api_id, Luma URL (or its trailing slug), or a fuzzy title match
 * of last resort. Tools should accept whatever form a caller naturally has —
 * `the-foundry-2026-05`, `https://luma.com/0zarmldc`, `0zarmldc`, or
 * `"foundry"` should all resolve to the same row.
 *
 * The UUID branch is shape-gated so non-UUID input doesn't trip postgres'
 * uuid type check. Title fuzzy match only fires when nothing more precise
 * worked, only on public published/completed events, and only when there's
 * exactly one match — ambiguous queries fall through to "not found" so the
 * caller can ask the user to disambiguate.
 */
async function resolveEvent(slugOrId: string): Promise<Event | null> {
  // If a Luma URL was passed, try its trailing slug first.
  const fromLumaUrl = extractLumaSlugSafe(slugOrId);
  const candidates = fromLumaUrl && fromLumaUrl !== slugOrId
    ? [slugOrId, fromLumaUrl]
    : [slugOrId];

  for (const candidate of candidates) {
    const direct = await eventsDb.getEventBySlug(candidate);
    if (direct) return direct;
    if (UUID_RE.test(candidate)) {
      const byId = await eventsDb.getEventById(candidate);
      if (byId) return byId;
    }
    const byLumaId = await eventsDb.getEventByLumaId(candidate);
    if (byLumaId) return byLumaId;
    const byLumaUrl = await eventsDb.getEventByLumaUrlSlug(candidate);
    if (byLumaUrl) return byLumaUrl;
  }

  return eventsDb.findEventByTitleFuzzy(slugOrId);
}

function extractLumaSlugSafe(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (!/(^|\.)lu\.ma$|(^|\.)luma\.com$/i.test(url.hostname)) return null;
    const path = url.pathname.replace(/^\//, '').split('/')[0];
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Generate a URL-friendly slug from a title
 */
function generateSlug(title: string): string {
  const date = new Date();
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  return `${slug}-${dateStr}`;
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
 * Read-only event tools available to all authenticated users.
 * These let any member check their registrations and browse upcoming events.
 */
export const EVENT_READONLY_TOOLS: AddieTool[] = [
  {
    name: 'list_events',
    description: `List AAO events personalized for the user. Shows:
- Events the user is already registered for
- Events in regional chapters they're a member of
- Events at industry gatherings they've indicated interest in (CES, Cannes Lions, etc.)
- Major global summits (open to all members)

Does NOT include virtual webinars (those are educational content).

When asked about past events, set include_past=true.
When asked about upcoming events or what's happening soon, use the defaults.

If the user isn't in any regional chapters or hasn't indicated interest in any industry events,
the response will suggest they share their location or join industry gathering groups.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_type: {
          type: 'string',
          enum: ['summit', 'meetup', 'workshop', 'conference', 'other'],
          description: 'Filter by event type (webinar excluded)',
        },
        include_past: {
          type: 'boolean',
          description: 'Include past/completed events (default: false, only shows upcoming)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default: 10)',
        },
      },
    },
  },
  {
    name: 'get_event_details',
    description: `Get details about a specific event including registration count and waitlist. Use this when someone asks about a specific event.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_slug: {
          type: 'string',
          description: 'Event identifier — internal slug, UUID, Luma api_id, full Luma URL, Luma URL slug, or unique title fragment',
        },
      },
      required: ['event_slug'],
    },
  },
  {
    name: 'register_event_interest',
    description: `Register the current user's interest in an event. Use when someone asks to be notified about an event, added to a waitlist, or wants to express interest without formally registering.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_slug: {
          type: 'string',
          description: 'Event identifier — internal slug, UUID, Luma api_id, full Luma URL, Luma URL slug, or unique title fragment',
        },
      },
      required: ['event_slug'],
    },
  },
  {
    name: 'list_event_attendees',
    description: `List who is registered for an event. Use when someone asks "who's coming to [event]?", "who's registered?", "attendee list", or "who will be there?". Shows names of registered attendees for published events.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_slug: {
          type: 'string',
          description: 'Event identifier — internal slug, UUID, Luma api_id, full Luma URL, Luma URL slug, or unique title fragment',
        },
      },
      required: ['event_slug'],
    },
  },
];

/**
 * Admin/committee-lead event tools for creating and managing events.
 * Gated behind canCreateEvents() permission check.
 */
export const EVENT_ADMIN_TOOLS: AddieTool[] = [
  {
    name: 'create_event',
    description: `Create a new AAO event. Use this when someone asks to create a meetup, webinar, summit, or workshop.
The event will be created in both Luma (for registration) and the AAO website.
Returns the Luma URL for sharing and the AAO event page URL.

Required: title, start_time (ISO format), event_type
Optional: description, end_time, timezone, location details, virtual_url, max_attendees`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Event title (e.g., "NYC AdTech Meetup - January 2026")',
        },
        description: {
          type: 'string',
          description: 'Event description (markdown supported)',
        },
        short_description: {
          type: 'string',
          description: 'One-line description for listings (max 200 chars)',
        },
        event_type: {
          type: 'string',
          enum: ['summit', 'meetup', 'webinar', 'workshop', 'conference', 'other'],
          description: 'Type of event',
        },
        event_format: {
          type: 'string',
          enum: ['in_person', 'virtual', 'hybrid'],
          description: 'Format: in_person, virtual, or hybrid',
        },
        start_time: {
          type: 'string',
          description: 'Start time in ISO 8601 format (e.g., "2026-01-15T18:00:00")',
        },
        end_time: {
          type: 'string',
          description: 'End time in ISO 8601 format (optional)',
        },
        timezone: {
          type: 'string',
          description: 'Timezone (e.g., "America/New_York", "America/Los_Angeles")',
        },
        venue_name: {
          type: 'string',
          description: 'Venue name (e.g., "WeWork Times Square")',
        },
        venue_address: {
          type: 'string',
          description: 'Full street address',
        },
        venue_city: {
          type: 'string',
          description: 'City name',
        },
        venue_country: {
          type: 'string',
          description: 'Country (default: United States)',
        },
        virtual_url: {
          type: 'string',
          description: 'Zoom/Meet link for virtual events (visible only to registered attendees)',
        },
        max_attendees: {
          type: 'number',
          description: 'Maximum capacity (0 for unlimited)',
        },
        publish_immediately: {
          type: 'boolean',
          description: 'Publish the event immediately (default: true)',
        },
        require_rsvp_approval: {
          type: 'boolean',
          description: 'If true, registrations require admin approval before being confirmed.',
        },
      },
      required: ['title', 'start_time', 'event_type'],
    },
  },
  {
    name: 'manage_event_registrations',
    description: `Manage event registrations - view registrations, approve waitlisted attendees, or export attendee list.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_slug: {
          type: 'string',
          description: 'Event identifier — internal slug, UUID, Luma api_id, full Luma URL, Luma URL slug, or unique title fragment',
        },
        action: {
          type: 'string',
          enum: ['list', 'approve_waitlist', 'export'],
          description: 'Action: list registrations, approve waitlisted, or export list',
        },
        registration_id: {
          type: 'string',
          description: 'Specific registration ID (for approve actions)',
        },
      },
      required: ['event_slug', 'action'],
    },
  },
  {
    name: 'update_event',
    description: `Update an existing event. Use this to change event details like description, capacity, or timing.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_slug: {
          type: 'string',
          description: 'Event identifier — internal slug, UUID, Luma api_id, full Luma URL, Luma URL slug, or unique title fragment',
        },
        title: {
          type: 'string',
          description: 'New title',
        },
        description: {
          type: 'string',
          description: 'New description',
        },
        start_time: {
          type: 'string',
          description: 'New start time (ISO 8601)',
        },
        end_time: {
          type: 'string',
          description: 'New end time (ISO 8601)',
        },
        max_attendees: {
          type: 'number',
          description: 'New capacity',
        },
        virtual_url: {
          type: 'string',
          description: 'New virtual meeting URL',
        },
        status: {
          type: 'string',
          enum: ['draft', 'published', 'cancelled'],
          description: 'Change event status',
        },
        require_rsvp_approval: {
          type: 'boolean',
          description: 'If true, registrations require admin approval before being confirmed.',
        },
      },
      required: ['event_slug'],
    },
  },
  {
    name: 'check_person_event_status',
    description: `Look up a specific person's status at an event. Use when someone asks "Is [person] invited to [event]?", "Did [person] attend [event]?", "What's [person]'s RSVP status?", etc.

Searches by name or email across invite list, registrations, and attendance records.
Returns their invite status, registration status, and whether they attended.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_slug: {
          type: 'string',
          description: 'Event identifier — internal slug, UUID, Luma api_id, full Luma URL, Luma URL slug, or unique title fragment',
        },
        person_query: {
          type: 'string',
          description: 'Person name or email to search for (e.g., "Bob Hope", "bob@stripe.com")',
        },
      },
      required: ['event_slug', 'person_query'],
    },
  },
  {
    name: 'invite_to_event',
    description: `Invite a person to an event. Adds them to the invite list and creates a registration record.

Use when someone says "Invite [person] to [event]", "Add [person] to the Foundry guest list", etc.

If draft_message is true, returns a suggested outreach message that can be sent via Slack or email.
The invitation is recorded immediately; the outreach message is a draft for the admin to review.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_slug: {
          type: 'string',
          description: 'Event identifier — internal slug, UUID, Luma api_id, full Luma URL, Luma URL slug, or unique title fragment',
        },
        email: {
          type: 'string',
          description: 'Email address of the person to invite',
        },
        name: {
          type: 'string',
          description: 'Display name of the person (optional)',
        },
        draft_message: {
          type: 'boolean',
          description: 'If true, draft an outreach message for the invite (default: true)',
        },
      },
      required: ['event_slug', 'email'],
    },
  },
];

/**
 * All event tools combined (for backward compatibility).
 */
export const EVENT_TOOLS: AddieTool[] = [...EVENT_READONLY_TOOLS, ...EVENT_ADMIN_TOOLS];

/**
 * Event tool handler implementations
 */
export function createEventToolHandlers(
  memberContext?: MemberContext | null,
  slackUserId?: string
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // Helper to check event creation permission
  const checkCreatePermission = async (): Promise<string | null> => {
    if (slackUserId) {
      const canCreate = await canCreateEvents(slackUserId);
      if (!canCreate) {
        return '⚠️ You need to be an AAO admin or committee lead to create events.';
      }
    } else if (memberContext) {
      if (memberContext.org_membership?.role !== 'admin') {
        return '⚠️ You need admin access to create events.';
      }
    }
    return null;
  };

  // Create event
  handlers.set('create_event', async (input) => {
    const permCheck = await checkCreatePermission();
    if (permCheck) return permCheck;

    const title = input.title as string;
    const startTimeStr = input.start_time as string;
    const eventType = (input.event_type as EventType) || 'meetup';
    const eventFormat = (input.event_format as EventFormat) || 'in_person';
    const timezone = (input.timezone as string) || 'America/New_York';
    const publishImmediately = input.publish_immediately !== false;

    // Parse dates
    const startTime = new Date(startTimeStr);
    if (isNaN(startTime.getTime())) {
      return `❌ Invalid start time format. Please use ISO 8601 format (e.g., "2026-01-15T18:00:00")`;
    }

    const endTime = input.end_time ? new Date(input.end_time as string) : undefined;
    if (endTime && isNaN(endTime.getTime())) {
      return `❌ Invalid end time format. Please use ISO 8601 format.`;
    }

    // Generate slug
    const slug = generateSlug(title);

    // Check if slug is available
    const slugAvailable = await eventsDb.isSlugAvailable(slug);
    if (!slugAvailable) {
      return `❌ An event with a similar name already exists. Please choose a different title.`;
    }

    // Prepare AAO event input
    const eventInput: CreateEventInput = {
      slug,
      title,
      description: input.description as string | undefined,
      short_description: input.short_description as string | undefined,
      event_type: eventType,
      event_format: eventFormat,
      start_time: startTime,
      end_time: endTime,
      timezone,
      venue_name: input.venue_name as string | undefined,
      venue_address: input.venue_address as string | undefined,
      venue_city: input.venue_city as string | undefined,
      venue_country: (input.venue_country as string) || 'United States',
      virtual_url: input.virtual_url as string | undefined,
      max_attendees: input.max_attendees as number | undefined,
      require_rsvp_approval: (input.require_rsvp_approval as boolean | undefined) ?? false,
      status: publishImmediately ? 'published' : 'draft',
      created_by_user_id: memberContext?.workos_user?.workos_user_id || slackUserId,
    };

    // Try to create in Luma first if enabled
    let lumaEventId: string | undefined;
    let lumaUrl: string | undefined;

    if (isLumaEnabled()) {
      try {
        const lumaInput: LumaCreateEventInput = {
          name: title,
          description: input.description as string | undefined,
          start_at: startTime.toISOString(),
          end_at: endTime?.toISOString() || new Date(startTime.getTime() + 2 * 60 * 60 * 1000).toISOString(),
          timezone,
          visibility: publishImmediately ? 'public' : 'private',
          require_rsvp_approval: (input.require_rsvp_approval as boolean | undefined) ?? false,
        };

        // Add location for in-person events
        if (eventFormat !== 'virtual' && input.venue_city) {
          lumaInput.geo_address_json = {
            city: input.venue_city as string,
            country: input.venue_country as string || 'United States',
            full_address: input.venue_address as string || undefined,
            description: input.venue_name as string || undefined,
          };
        }

        // Add virtual URL
        if (input.virtual_url) {
          lumaInput.meeting_url = input.virtual_url as string;
        }

        const lumaEvent = await createLumaEvent(lumaInput);
        lumaEventId = lumaEvent.api_id;
        lumaUrl = lumaEvent.url;

        logger.info({ lumaEventId, lumaUrl }, 'Created event in Luma');
      } catch (lumaError) {
        logger.warn({ err: lumaError, title }, 'Failed to create event in Luma, continuing with AAO-only');
      }
    }

    // Add Luma IDs if we created there
    if (lumaEventId) {
      eventInput.luma_event_id = lumaEventId;
      eventInput.luma_url = lumaUrl;
    }

    // Create in AAO database
    const event = await eventsDb.createEvent(eventInput);

    // Build response
    const baseUrl = process.env.PUBLIC_URL || 'https://agenticadvertising.org';
    const aaoUrl = `${baseUrl}/events/${event.slug}`;

    let response = `✅ Created event: **${title}**\n\n`;
    response += `**When:** ${formatDate(startTime)} at ${formatTime(startTime, timezone)}\n`;

    if (eventFormat !== 'virtual' && input.venue_city) {
      response += `**Where:** ${input.venue_name || input.venue_city}\n`;
    } else if (eventFormat === 'virtual') {
      response += `**Format:** Virtual\n`;
    }

    response += `**Type:** ${eventType.replace('_', ' ')}\n`;

    if (event.max_attendees) {
      response += `**Capacity:** ${event.max_attendees} attendees\n`;
    }

    response += `\n**Links:**\n`;
    response += `• AAO Page: ${aaoUrl}\n`;
    if (lumaUrl) {
      response += `• Registration: ${lumaUrl}\n`;
    }

    if (!publishImmediately) {
      response += `\n_Event is saved as draft. Use update_event to publish when ready._`;
    }

    logger.info({
      eventId: event.id,
      slug: event.slug,
      lumaEventId,
      createdBy: memberContext?.workos_user?.workos_user_id || slackUserId,
    }, 'Event created via Addie');

    return response;
  });

  // List events (personalized for the user)
  handlers.set('list_events', async (input) => {
    const eventType = input.event_type as EventType | undefined;
    const includePast = input.include_past === true;
    const limit = Math.min((input.limit as number) || 10, 20);

    // Get workos user ID and email from member context
    const workosUserId = memberContext?.workos_user?.workos_user_id;
    const userEmail = memberContext?.workos_user?.email ?? memberContext?.slack_user?.email ?? undefined;

    // Get personalized events for this user
    const personalizedResult = await getPersonalizedEvents(workosUserId, slackUserId, includePast, userEmail);
    let allEvents = personalizedResult.events;

    // Filter by event type if specified (excluding webinars)
    if (eventType && eventType !== 'webinar') {
      allEvents = allEvents.filter(e => e.event_type === eventType);
    }

    // Apply limit
    allEvents = allEvents.slice(0, limit);

    // Build response
    let response = '';

    // If no events found, provide helpful context
    if (allEvents.length === 0) {
      if (includePast) {
        response = 'I don\'t see any past events that are relevant to you.\n\n';
      } else {
        response = 'I don\'t see any upcoming events that match your profile.\n\n';
      }

      // Provide guidance on how to see more events
      const suggestions: string[] = [];

      if (personalizedResult.missingLocation) {
        suggestions.push('**Share your location** - Tell me where you\'re based (e.g., "I\'m in New York") so I can show you events in your area.');
      }

      if (personalizedResult.chapters.length === 0) {
        suggestions.push('**Join a regional chapter** - We have chapters in various cities. Let me know your city and I can help you connect.');
      }

      if (personalizedResult.industryGatherings.length === 0) {
        suggestions.push('**Tell me about industry events you\'re attending** - Going to CES, Cannes Lions, or other industry events? Let me know and I\'ll connect you with our gatherings there.');
      }

      if (suggestions.length > 0) {
        response += 'To see more relevant events, you could:\n\n';
        response += suggestions.map(s => `• ${s}`).join('\n\n');
      }

      return response;
    }

    // Build header with context
    response = includePast ? `## Past Events\n\n` : `## Upcoming Events\n\n`;

    // Add context about what we're showing
    const contextParts: string[] = [];
    if (personalizedResult.chapters.length > 0) {
      contextParts.push(`your chapter${personalizedResult.chapters.length > 1 ? 's' : ''} (${personalizedResult.chapters.map(c => c.name).join(', ')})`);
    }
    if (personalizedResult.industryGatherings.length > 0) {
      contextParts.push(`industry gatherings you're interested in (${personalizedResult.industryGatherings.map(g => g.name).join(', ')})`);
    }
    if (contextParts.length > 0) {
      response += `_Showing events based on ${contextParts.join(' and ')}, plus global summits._\n\n`;
    }

    // List events
    const eventTypeEmojis: Record<string, string> = {
      summit: '🏔️',
      meetup: '🤝',
      workshop: '🛠️',
      conference: '🎤',
      other: '📅',
    };
    for (const event of allEvents) {
      const typeEmoji = eventTypeEmojis[event.event_type] || '📅';

      response += `${typeEmoji} **${event.title}**\n`;
      response += `   ${formatDate(event.start_time)} at ${formatTime(event.start_time, event.timezone)}\n`;

      if (event.venue_city) {
        response += `   📍 ${event.venue_city}`;
        if (event.venue_name) response += ` - ${event.venue_name}`;
        response += `\n`;
      }

      if (!includePast && event.luma_url) {
        response += `   🔗 Register: ${event.luma_url}\n`;
      }
      response += `\n`;
    }

    // If location is missing, add a helpful note
    if (personalizedResult.missingLocation && !includePast) {
      response += `\n_Want to see events in your area? Tell me where you're based!_\n`;
    }

    return response;
  });

  // Get event details
  handlers.set('get_event_details', async (input) => {
    const eventSlug = input.event_slug as string;

    const event = await resolveEvent(eventSlug);
    if (!event) {
      return `❌ Event not found: "${eventSlug}"`;
    }

    // Non-admin users can only see published/completed public events
    const isAdmin = slackUserId ? await canCreateEvents(slackUserId) : (memberContext?.org_membership?.role === 'admin');
    if (!isAdmin && !['published', 'completed'].includes(event.status)) {
      return `❌ Event not found: "${eventSlug}"`;
    }
    if (!isAdmin && event.visibility === 'invite_unlisted') {
      return `❌ Event not found: "${eventSlug}"`;
    }

    const registrations = await eventsDb.getEventRegistrations(event.id);
    const registered = registrations.filter(r => r.registration_status === 'registered').length;
    const waitlisted = registrations.filter(r => r.registration_status === 'waitlisted').length;
    const attended = registrations.filter(r => r.attended).length;

    let response = `## ${event.title}\n\n`;
    response += `**Status:** ${event.status}\n`;
    response += `**Type:** ${event.event_type} (${event.event_format})\n`;
    response += `**When:** ${formatDate(event.start_time)} at ${formatTime(event.start_time, event.timezone)}\n`;

    if (event.venue_city) {
      response += `**Where:** `;
      if (event.venue_name) response += `${event.venue_name}, `;
      response += `${event.venue_city}\n`;
      if (event.venue_address) response += `   ${event.venue_address}\n`;
    }

    response += `\n### Registrations\n`;
    response += `• **Registered:** ${registered}`;
    if (event.max_attendees) response += ` / ${event.max_attendees}`;
    response += `\n`;
    if (waitlisted > 0) response += `• **Waitlisted:** ${waitlisted}\n`;
    if (attended > 0) response += `• **Attended:** ${attended}\n`;

    response += `\n### Links\n`;
    const baseUrl = process.env.PUBLIC_URL || 'https://agenticadvertising.org';
    response += `• AAO Page: ${baseUrl}/events/${event.slug}\n`;
    if (event.luma_url) {
      response += `• Registration: ${event.luma_url}\n`;
    }

    if (event.description) {
      response += `\n### Description\n${event.description.substring(0, 500)}`;
      if (event.description.length > 500) response += '...';
      response += '\n';
    }

    return response;
  });

  // Manage registrations
  handlers.set('manage_event_registrations', async (input) => {
    const permCheck = await checkCreatePermission();
    if (permCheck) return permCheck;

    const eventSlug = input.event_slug as string;
    const action = input.action as string;

    const event = await resolveEvent(eventSlug);
    if (!event) {
      return `❌ Event not found: "${eventSlug}"`;
    }

    const registrations = await eventsDb.getEventRegistrations(event.id);

    switch (action) {
      case 'list': {
        if (registrations.length === 0) {
          return `No registrations yet for "${event.title}".`;
        }

        let response = `## Registrations for ${event.title}\n\n`;
        response += `**Total:** ${registrations.length}\n\n`;

        const byStatus = {
          registered: registrations.filter(r => r.registration_status === 'registered'),
          waitlisted: registrations.filter(r => r.registration_status === 'waitlisted'),
          cancelled: registrations.filter(r => r.registration_status === 'cancelled'),
        };

        if (byStatus.registered.length > 0) {
          response += `### Registered (${byStatus.registered.length})\n`;
          for (const reg of byStatus.registered.slice(0, 20)) {
            const name = reg.name || reg.email?.split('@')[0] || 'Unknown';
            const checkMark = reg.attended ? ' ✅' : '';
            response += `• ${name}${checkMark}\n`;
          }
          if (byStatus.registered.length > 20) {
            response += `   _...and ${byStatus.registered.length - 20} more_\n`;
          }
          response += '\n';
        }

        if (byStatus.waitlisted.length > 0) {
          response += `### Waitlisted (${byStatus.waitlisted.length})\n`;
          for (const reg of byStatus.waitlisted.slice(0, 10)) {
            const name = reg.name || reg.email?.split('@')[0] || 'Unknown';
            response += `• ${name} (ID: ${reg.id.substring(0, 8)})\n`;
          }
          response += '\n';
        }

        return response;
      }

      case 'approve_waitlist': {
        const regId = input.registration_id as string;

        if (regId) {
          // Approve specific registration
          const reg = registrations.find(r => r.id === regId || r.id.startsWith(regId));
          if (!reg) {
            return `❌ Registration not found: ${regId}`;
          }

          // If synced from Luma, approve there too
          if (reg.luma_guest_id) {
            await approveGuest(reg.luma_guest_id);
          }

          // Update local status
          await eventsDb.cancelRegistration(reg.id); // Reuse for status update
          return `✅ Approved registration for ${reg.name || reg.email}`;
        } else {
          // Approve all waitlisted
          const waitlisted = registrations.filter(r => r.registration_status === 'waitlisted');
          if (waitlisted.length === 0) {
            return 'No waitlisted registrations to approve.';
          }

          let approved = 0;
          for (const reg of waitlisted) {
            if (reg.luma_guest_id) {
              await approveGuest(reg.luma_guest_id);
            }
            approved++;
          }

          return `✅ Approved ${approved} waitlisted registration(s).`;
        }
      }

      case 'export': {
        if (registrations.length === 0) {
          return 'No registrations to export.';
        }

        let csv = 'Name,Email,Status,Registered At,Attended\n';
        for (const reg of registrations) {
          const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
          csv += `${esc(reg.name || '')},${esc(reg.email || '')},${esc(reg.registration_status)},${esc(reg.registered_at.toISOString())},${esc(reg.attended ? 'Yes' : 'No')}\n`;
        }

        return `## Registration Export for ${event.title}\n\n\`\`\`csv\n${csv}\`\`\``;
      }

      default:
        return `Unknown action: ${action}. Use: list, approve_waitlist, or export.`;
    }
  });

  // Update event
  handlers.set('update_event', async (input) => {
    const permCheck = await checkCreatePermission();
    if (permCheck) return permCheck;

    const eventSlug = input.event_slug as string;

    const event = await resolveEvent(eventSlug);
    if (!event) {
      return `❌ Event not found: "${eventSlug}"`;
    }

    const updates: Record<string, unknown> = {};
    const changes: string[] = [];

    if (input.title) {
      updates.title = input.title;
      changes.push(`Title → ${input.title}`);
    }
    if (input.description) {
      updates.description = input.description;
      changes.push('Description updated');
    }
    if (input.start_time) {
      updates.start_time = new Date(input.start_time as string);
      changes.push(`Start time → ${formatDate(updates.start_time as Date)}`);
    }
    if (input.end_time) {
      updates.end_time = new Date(input.end_time as string);
      changes.push('End time updated');
    }
    if (input.max_attendees !== undefined) {
      updates.max_attendees = input.max_attendees;
      changes.push(`Capacity → ${input.max_attendees || 'unlimited'}`);
    }
    if (input.virtual_url) {
      updates.virtual_url = input.virtual_url;
      changes.push('Virtual URL updated');
    }
    if (input.status) {
      updates.status = input.status;
      if (input.status === 'published') {
        updates.published_at = new Date();
      }
      changes.push(`Status → ${input.status}`);
    }
    if (input.require_rsvp_approval !== undefined) {
      updates.require_rsvp_approval = input.require_rsvp_approval;
      changes.push(`RSVP approval → ${input.require_rsvp_approval ? 'required' : 'open'}`);
    }

    if (changes.length === 0) {
      return 'No changes provided. Specify at least one field to update.';
    }

    await eventsDb.updateEvent(event.id, updates);

    // Sync to Luma if event has a Luma ID
    if (event.luma_event_id && isLumaEnabled()) {
      const lumaUpdates: LumaUpdateEventInput = {};
      if (updates.title) lumaUpdates.name = updates.title as string;
      if (updates.description) lumaUpdates.description = updates.description as string;
      if (updates.start_time) lumaUpdates.start_at = (updates.start_time as Date).toISOString();
      if (updates.end_time) lumaUpdates.end_at = (updates.end_time as Date).toISOString();
      if (updates.virtual_url) lumaUpdates.meeting_url = updates.virtual_url as string;
      if (updates.status) lumaUpdates.visibility = updates.status === 'published' ? 'public' : 'private';
      if (updates.require_rsvp_approval !== undefined) lumaUpdates.require_rsvp_approval = updates.require_rsvp_approval as boolean;

      if (Object.keys(lumaUpdates).length > 0) {
        try {
          await updateLumaEvent(event.luma_event_id, lumaUpdates);
          logger.info({ lumaEventId: event.luma_event_id, updates: Object.keys(lumaUpdates) }, 'Synced event update to Luma');
        } catch (lumaError) {
          logger.warn({ err: lumaError, lumaEventId: event.luma_event_id }, 'Failed to sync event update to Luma');
        }
      }
    }

    logger.info({
      eventId: event.id,
      updates: Object.keys(updates),
      updatedBy: memberContext?.workos_user?.workos_user_id || slackUserId,
    }, 'Event updated via Addie');

    return `✅ Updated **${event.title}**\n\n${changes.map(c => `• ${c}`).join('\n')}`;
  });

  // Register interest in an event
  handlers.set('register_event_interest', async (input) => {
    const eventSlug = input.event_slug as string;

    const event = await resolveEvent(eventSlug);
    if (!event) {
      return `❌ Event not found: "${eventSlug}"`;
    }

    // Non-admin users can only register interest in published public events
    const isAdmin = slackUserId ? await canCreateEvents(slackUserId) : (memberContext?.org_membership?.role === 'admin');
    if (!isAdmin && !['published', 'completed'].includes(event.status)) {
      return `❌ Event not found: "${eventSlug}"`;
    }
    if (!isAdmin && event.visibility === 'invite_unlisted') {
      return `❌ Event not found: "${eventSlug}"`;
    }

    const email = memberContext?.workos_user?.email ?? memberContext?.slack_user?.email ?? null;
    if (!email) {
      return `I don't have your email address on file. Could you share it so I can add you to the interest list?`;
    }

    const displayName = memberContext?.workos_user
      ? [memberContext.workos_user.first_name, memberContext.workos_user.last_name].filter(Boolean).join(' ') || undefined
      : memberContext?.slack_user?.display_name ?? undefined;

    // Check if already registered so we can give a useful response
    const workosUserId = memberContext?.workos_user?.workos_user_id;
    if (workosUserId) {
      const alreadyRegistered = await eventsDb.isUserRegistered(event.id, workosUserId, email);
      if (alreadyRegistered) {
        return `You're already registered for **${event.title}** — no need to join the interest list separately.`;
      }
    }

    const contact = await upsertEmailContact({ email, displayName });

    try {
      await eventsDb.createRegistration({
        event_id: event.id,
        email_contact_id: contact.contactId,
        email,
        name: displayName,
        registration_status: 'waitlisted',
        registration_source: 'interest',
      });
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      // Unique constraint hit — already expressed interest
    }

    logger.info({ eventId: event.id, email, contactId: contact.contactId }, 'Event interest registered via Addie');

    return `✅ You're on the interest list for **${event.title}**. We'll keep you posted on updates.`;
  });

  // List event attendees (available to all members)
  handlers.set('list_event_attendees', async (input) => {
    const eventSlug = input.event_slug as string;

    const event = await resolveEvent(eventSlug);
    if (!event) {
      return `❌ Event not found: "${eventSlug}"`;
    }

    // Non-admin users can only see attendees for published/completed public events
    const isAdmin = slackUserId ? await canCreateEvents(slackUserId) : (memberContext?.org_membership?.role === 'admin');
    if (!isAdmin && !['published', 'completed'].includes(event.status)) {
      return `❌ Event not found: "${eventSlug}"`;
    }
    if (!isAdmin && event.visibility === 'invite_unlisted') {
      return `❌ Event not found: "${eventSlug}"`;
    }

    const attendees = await eventsDb.getEventAttendeeSummary(event.id);
    const registered = attendees.filter(r => r.registration_status === 'registered');
    const waitlisted = attendees.filter(r => r.registration_status === 'waitlisted');

    if (registered.length === 0 && waitlisted.length === 0) {
      return `No one has registered for **${event.title}** yet.`;
    }

    const MAX_DISPLAY = 30;
    let response = `## Who's coming to ${event.title}\n\n`;

    if (registered.length > 0) {
      response += `**Registered (${registered.length})**\n`;
      for (const reg of registered.slice(0, MAX_DISPLAY)) {
        const name = isAdmin
          ? (reg.name || reg.email?.split('@')[0] || 'Unknown')
          : (reg.name || 'Attendee');
        const checkMark = isAdmin && reg.attended ? ' ✅' : '';
        response += `• ${name}${checkMark}\n`;
      }
      if (registered.length > MAX_DISPLAY) {
        response += `_...and ${registered.length - MAX_DISPLAY} more_\n`;
      }
      response += '\n';
    }

    if (waitlisted.length > 0) {
      response += `**Waitlisted (${waitlisted.length})**\n`;
      for (const reg of waitlisted.slice(0, MAX_DISPLAY)) {
        const name = isAdmin
          ? (reg.name || reg.email?.split('@')[0] || 'Unknown')
          : (reg.name || 'Attendee');
        response += `• ${name}\n`;
      }
      if (waitlisted.length > MAX_DISPLAY) {
        response += `_...and ${waitlisted.length - MAX_DISPLAY} more_\n`;
      }
    }

    return response;
  });

  // Check person's event status
  handlers.set('check_person_event_status', async (input) => {
    const permCheck = await checkCreatePermission();
    if (permCheck) return permCheck;

    const eventSlug = input.event_slug as string;
    const personQuery = (input.person_query as string).toLowerCase().trim();

    const event = await resolveEvent(eventSlug);
    if (!event) return `❌ Event not found: "${eventSlug}"`;

    const isEmail = personQuery.includes('@');

    // Check invite list
    const invites = await eventsDb.getEventInvites(event.id);
    const matchingInvite = invites.find(inv =>
      isEmail
        ? inv.email.toLowerCase() === personQuery
        : inv.email.toLowerCase().includes(personQuery)
    );

    // Check registrations
    const registrations = await eventsDb.getEventRegistrations(event.id);
    const matchingRegs = registrations.filter(reg => {
      if (isEmail) {
        return reg.email?.toLowerCase() === personQuery;
      }
      const nameMatch = reg.name?.toLowerCase().includes(personQuery);
      const emailMatch = reg.email?.toLowerCase().includes(personQuery);
      return nameMatch || emailMatch;
    });

    if (!matchingInvite && matchingRegs.length === 0) {
      return `No record of "${input.person_query}" for **${event.title}**. They haven't been invited or registered.`;
    }

    let response = `## ${input.person_query} — ${event.title}\n\n`;

    if (matchingInvite) {
      response += `**Invited:** Yes (${matchingInvite.email})\n`;
    } else {
      response += `**Invited:** Not on the invite list\n`;
    }

    if (matchingRegs.length > 0) {
      const reg = matchingRegs[0];
      const statusLabels: Record<string, string> = {
        registered: 'Accepted',
        waitlisted: 'Waitlisted',
        interested: 'Interested (no RSVP)',
        cancelled: 'Declined',
        no_show: 'No-show',
      };

      response += `**RSVP:** ${statusLabels[reg.registration_status] || reg.registration_status}\n`;
      response += `**Source:** ${reg.registration_source}\n`;

      if (reg.attended) {
        response += `**Attended:** Yes`;
        if (reg.checked_in_at) response += ` (checked in ${new Date(reg.checked_in_at).toLocaleString()})`;
        response += `\n`;
      } else if (new Date(event.start_time) < new Date()) {
        response += `**Attended:** No\n`;
      }

      if (reg.email) response += `**Email:** ${reg.email}\n`;
    }

    return response;
  });

  // Invite person to event
  handlers.set('invite_to_event', async (input) => {
    const permCheck = await checkCreatePermission();
    if (permCheck) return permCheck;

    const eventSlug = input.event_slug as string;
    const email = (input.email as string).toLowerCase().trim();
    const name = input.name as string | undefined;
    const draftMessage = input.draft_message !== false;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return `❌ Invalid email address: "${email}"`;
    }

    const event = await resolveEvent(eventSlug);
    if (!event) return `❌ Event not found: "${eventSlug}"`;

    // Check if already registered
    const registrations = await eventsDb.getEventRegistrations(event.id);
    const existing = registrations.find(r => r.email?.toLowerCase() === email);
    if (existing && existing.registration_status === 'registered') {
      return `${name || email} is already registered for **${event.title}**.`;
    }

    // Add to invite list
    const invitedByUserId = memberContext?.workos_user?.workos_user_id;
    await eventsDb.addInvites(event.id, [email], invitedByUserId);

    // Create registration if they don't have one
    if (!existing) {
      const contact = await upsertEmailContact({ email, displayName: name });
      try {
        await eventsDb.createRegistration({
          event_id: event.id,
          email_contact_id: contact.contactId,
          email,
          name,
          registration_status: 'interested',
          registration_source: 'admin',
        });
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
      }
    }

    const baseUrl = process.env.PUBLIC_URL || 'https://agenticadvertising.org';
    const eventUrl = `${baseUrl}/events/${event.slug}`;
    const displayName = name || email.split('@')[0];

    let response = `✅ **${displayName}** has been invited to **${event.title}**.\n`;
    response += `• Added to invite list\n`;
    response += `• Registration status: ${existing ? existing.registration_status : 'interested'}\n\n`;

    if (draftMessage) {
      const eventDate = formatDate(event.start_time);
      const location = event.venue_city
        ? `${event.venue_name ? event.venue_name + ', ' : ''}${event.venue_city}`
        : 'Virtual';

      response += `### Draft outreach message\n\n`;
      response += `> Hi ${displayName.split(' ')[0]},\n>\n`;
      response += `> I'd like to invite you to **${event.title}** on ${eventDate}`;
      if (location !== 'Virtual') response += ` in ${location}`;
      response += `.\n>\n`;
      response += `> ${event.short_description || event.description?.substring(0, 200) || 'Join us for a great discussion on agentic advertising.'}\n>\n`;
      if (event.luma_url) {
        response += `> Register here: ${event.luma_url}\n>\n`;
      } else {
        response += `> Details: ${eventUrl}\n>\n`;
      }
      response += `> Would love to see you there!\n\n`;
      response += `_You can send this via Slack DM or email. Want me to send it?_`;
    }

    logger.info({
      eventId: event.id,
      invitedEmail: email,
      invitedBy: invitedByUserId || slackUserId,
    }, 'Person invited to event via Addie');

    return response;
  });

  return handlers;
}
