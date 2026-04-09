/**
 * Event Recap Nudge Job
 *
 * Runs daily. Finds completed events from the last 7 days that are missing
 * recaps or attendee lists, and posts a reminder to the editorial Slack channel.
 */

import { createLogger } from '../../logger.js';
import { eventsDb } from '../../db/events-db.js';
import { query } from '../../db/client.js';
import { sendChannelMessage } from '../../slack/client.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import type { Event } from '../../types.js';

const logger = createLogger('event-recap-nudge');

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

interface RecapNudgeResult {
  eventsChecked: number;
  nudgesSent: number;
}

/**
 * Find completed events from the last 7 days that need attention.
 */
async function findEventsNeedingRecap(): Promise<Event[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const result = await query<Event>(
    `SELECT * FROM events
     WHERE status = 'completed'
       AND end_time >= $1
       AND end_time < NOW()
       AND recap_html IS NULL
       AND (metadata->>'recap_nudged_at' IS NULL
            OR (metadata->>'recap_nudged_at')::timestamptz < NOW() - INTERVAL '2 days')
     ORDER BY end_time DESC`,
    [sevenDaysAgo.toISOString()]
  );

  return result.rows;
}

/**
 * Find completed events missing attendee imports.
 */
async function findEventsMissingAttendees(): Promise<Event[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const result = await query<Event>(
    `SELECT e.* FROM events e
     WHERE e.status = 'completed'
       AND e.end_time >= $1
       AND e.end_time < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM event_registrations er WHERE er.event_id = e.id
       )
     ORDER BY e.end_time DESC`,
    [sevenDaysAgo.toISOString()]
  );

  return result.rows;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeSlackMrkdwn(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]!));
}

export async function runEventRecapNudgeJob(): Promise<RecapNudgeResult> {
  const result: RecapNudgeResult = { eventsChecked: 0, nudgesSent: 0 };

  const [needsRecap, needsAttendees] = await Promise.all([
    findEventsNeedingRecap(),
    findEventsMissingAttendees(),
  ]);

  // Deduplicate — some events may be in both lists
  const allEventIds = new Set([
    ...needsRecap.map(e => e.id),
    ...needsAttendees.map(e => e.id),
  ]);
  result.eventsChecked = allEventIds.size;

  if (allEventIds.size === 0) {
    logger.debug('No events need recap nudges');
    return result;
  }

  // Get editorial channel
  const workingGroupDb = new WorkingGroupDatabase();
  const editorial = await workingGroupDb.getWorkingGroupBySlug('editorial');
  if (!editorial?.slack_channel_id) {
    logger.warn('Editorial working group has no Slack channel — cannot send recap nudges');
    return result;
  }

  // Build a single message with all events needing attention
  const lines: string[] = [];
  lines.push(':clipboard: *Post-Event Checklist*\n');

  for (const event of needsRecap) {
    const missingAttendees = needsAttendees.some(e => e.id === event.id);
    const items: string[] = [];
    items.push('Add a recap with highlights and recording link');
    if (missingAttendees) {
      items.push('Upload attendee list (Luma CSV or Zoom participant report)');
    }

    const eventDate = formatDate(new Date(event.end_time || event.start_time));
    lines.push(`*${escapeSlackMrkdwn(event.title)}* (${eventDate})`);
    for (const item of items) {
      lines.push(`  • ${item}`);
    }
    lines.push(`  <${APP_URL}/admin/events|Manage Events>`);
    lines.push('');
  }

  // Events that have recaps but no attendees
  for (const event of needsAttendees) {
    if (needsRecap.some(e => e.id === event.id)) continue; // Already listed
    const eventDate = formatDate(new Date(event.end_time || event.start_time));
    lines.push(`*${escapeSlackMrkdwn(event.title)}* (${eventDate})`);
    lines.push(`  • Upload attendee list (Luma CSV or Zoom participant report)`);
    lines.push(`  <${APP_URL}/admin/events|Manage Events>`);
    lines.push('');
  }

  const messageText = lines.join('\n');

  const postResult = await sendChannelMessage(editorial.slack_channel_id, {
    text: messageText,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: messageText },
      },
    ],
  });

  if (postResult.ok) {
    result.nudgesSent = allEventIds.size;

    // Mark events as nudged (JSONB merge to preserve existing metadata)
    for (const eventId of allEventIds) {
      try {
        await query(
          `UPDATE events
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
               updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify({ recap_nudged_at: new Date().toISOString() }), eventId]
        );
      } catch (err) {
        logger.error({ err, eventId }, 'Failed to mark event as nudged');
      }
    }

    logger.info({ nudgesSent: result.nudgesSent, channel: editorial.slack_channel_id }, 'Sent event recap nudges');
  } else {
    logger.error({ error: postResult.error }, 'Failed to send recap nudges to Slack');
  }

  return result;
}
