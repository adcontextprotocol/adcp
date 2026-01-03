/**
 * Activity Builder
 *
 * Builds activity feed from events and working group activity.
 */

import type { ActivityItem } from '../types.js';
import type { MemberContext } from '../../member-context.js';
import { EventsDatabase } from '../../../db/events-db.js';
import { logger } from '../../../logger.js';

const eventsDb = new EventsDatabase();

/**
 * Build activity feed with upcoming events and working group activity
 */
export async function buildActivityFeed(memberContext: MemberContext): Promise<ActivityItem[]> {
  const activity: ActivityItem[] = [];

  // Fetch upcoming events
  try {
    const upcomingEvents = await eventsDb.getUpcomingEvents();

    // Take top 3 upcoming events
    for (const event of upcomingEvents.slice(0, 3)) {
      const eventDate = new Date(event.start_time);
      const isVirtual = event.event_format === 'virtual';
      const location = isVirtual
        ? 'Virtual'
        : event.venue_city
          ? `${event.venue_city}${event.venue_state ? `, ${event.venue_state}` : ''}`
          : 'TBD';

      activity.push({
        id: `event-${event.id}`,
        type: 'event',
        title: event.title,
        description: `${formatEventDate(eventDate)} - ${location}`,
        timestamp: eventDate,
        url: event.luma_url ?? undefined,
        metadata: {
          eventType: event.event_type,
          registrationCount: event.registration_count,
        },
      });
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to fetch upcoming events for home activity');
  }

  // Add working group activity if user is in groups
  if (memberContext.working_groups && memberContext.working_groups.length > 0) {
    // Show a summary of user's working group involvement
    const leaderGroups = memberContext.working_groups.filter(g => g.is_leader);
    if (leaderGroups.length > 0) {
      activity.push({
        id: 'working-group-leadership',
        type: 'working_group',
        title: 'Your Leadership Roles',
        description: `Leading ${leaderGroups.map(g => g.name).join(', ')}`,
        timestamp: new Date(),
      });
    }
  }

  // Sort by timestamp (most recent first for working groups, soonest first for events)
  return activity.sort((a, b) => {
    // Events should show soonest first
    if (a.type === 'event' && b.type === 'event') {
      return a.timestamp.getTime() - b.timestamp.getTime();
    }
    // Working group items after events
    if (a.type === 'event') return -1;
    if (b.type === 'event') return 1;
    return 0;
  });
}

/**
 * Format event date for display
 */
function formatEventDate(date: Date): string {
  const now = new Date();
  const diffDays = Math.floor((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return 'Today';
  } else if (diffDays === 1) {
    return 'Tomorrow';
  } else if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}
