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
import { isSlackUserAdmin } from './admin-tools.js';
import { eventsDb } from '../../db/events-db.js';
import {
  createEvent as createLumaEvent,
  getEvent as getLumaEvent,
  getEventGuests,
  approveGuest,
  declineGuest,
  isLumaEnabled,
  type CreateEventInput as LumaCreateEventInput,
} from '../../luma/client.js';
import type {
  CreateEventInput,
  EventType,
  EventFormat,
} from '../../types.js';

const logger = createLogger('addie-event-tools');

// Committee slugs whose leads can create events
const EVENT_CREATOR_COMMITTEES = ['marketing', 'education', 'aao-admin'];

/**
 * Check if a Slack user can create events
 * Must be an admin or lead of marketing/education committees
 */
export async function canCreateEvents(slackUserId: string): Promise<boolean> {
  // Admins can always create events
  const isAdmin = await isSlackUserAdmin(slackUserId);
  if (isAdmin) return true;

  // TODO: Check committee membership when that's implemented
  // For now, only admins can create events
  return false;
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
 * Event tool definitions
 */
export const EVENT_TOOLS: AddieTool[] = [
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
      },
      required: ['title', 'start_time', 'event_type'],
    },
  },
  {
    name: 'list_upcoming_events',
    description: `List upcoming AAO events. Use this when someone asks about upcoming events, the events calendar, or what's happening soon.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        event_type: {
          type: 'string',
          enum: ['summit', 'meetup', 'webinar', 'workshop', 'conference', 'other'],
          description: 'Filter by event type',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default: 5)',
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
          description: 'Event slug (URL identifier) or event ID',
        },
      },
      required: ['event_slug'],
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
          description: 'Event slug or ID',
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
          description: 'Event slug or ID',
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
      },
      required: ['event_slug'],
    },
  },
];

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

  // List upcoming events
  handlers.set('list_upcoming_events', async (input) => {
    const eventType = input.event_type as EventType | undefined;
    const limit = Math.min((input.limit as number) || 5, 20);

    const events = await eventsDb.listEvents({
      status: 'published',
      event_type: eventType,
      upcoming_only: true,
      limit,
    });

    if (events.length === 0) {
      let msg = 'No upcoming events found';
      if (eventType) msg += ` of type "${eventType}"`;
      return msg + '.';
    }

    let response = `## Upcoming Events\n\n`;

    for (const event of events) {
      const typeEmoji = {
        summit: '🏔️',
        meetup: '🤝',
        webinar: '💻',
        workshop: '🛠️',
        conference: '🎤',
        other: '📅',
      }[event.event_type] || '📅';

      response += `${typeEmoji} **${event.title}**\n`;
      response += `   ${formatDate(event.start_time)} at ${formatTime(event.start_time, event.timezone)}\n`;

      if (event.venue_city) {
        response += `   📍 ${event.venue_city}`;
        if (event.venue_name) response += ` - ${event.venue_name}`;
        response += `\n`;
      } else if (event.event_format === 'virtual') {
        response += `   💻 Virtual\n`;
      }

      if (event.luma_url) {
        response += `   🔗 Register: ${event.luma_url}\n`;
      }
      response += `\n`;
    }

    return response;
  });

  // Get event details
  handlers.set('get_event_details', async (input) => {
    const eventSlug = input.event_slug as string;

    // Try to find by slug first, then by ID
    let event = await eventsDb.getEventBySlug(eventSlug);
    if (!event) {
      event = await eventsDb.getEventById(eventSlug);
    }

    if (!event) {
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

    let event = await eventsDb.getEventBySlug(eventSlug);
    if (!event) {
      event = await eventsDb.getEventById(eventSlug);
    }

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
          csv += `"${reg.name || ''}","${reg.email || ''}","${reg.registration_status}","${reg.registered_at.toISOString()}","${reg.attended ? 'Yes' : 'No'}"\n`;
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

    let event = await eventsDb.getEventBySlug(eventSlug);
    if (!event) {
      event = await eventsDb.getEventById(eventSlug);
    }

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

    if (changes.length === 0) {
      return 'No changes provided. Specify at least one field to update.';
    }

    await eventsDb.updateEvent(event.id, updates);

    // TODO: Update Luma event if luma_event_id exists

    logger.info({
      eventId: event.id,
      updates: Object.keys(updates),
      updatedBy: memberContext?.workos_user?.workos_user_id || slackUserId,
    }, 'Event updated via Addie');

    return `✅ Updated **${event.title}**\n\n${changes.map(c => `• ${c}`).join('\n')}`;
  });

  return handlers;
}
