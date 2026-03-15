/**
 * Person Events — append-only activity log for each person.
 *
 * Every meaningful thing that happens to/with/by a person is recorded here.
 * This is the single source of truth for debugging, replay, and simulation.
 */

import { query } from './client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PersonEventType =
  | 'identity_linked'
  | 'message_sent'          // Addie → person
  | 'message_received'      // person → Addie
  | 'outreach_decided'      // scheduler decided to contact
  | 'outreach_skipped'      // scheduler decided not to contact
  | 'message_composed'      // Sonnet composed (or skipped) a message
  | 'stage_changed'
  | 'account_linked'
  | 'group_joined'
  | 'group_left'
  | 'opted_out'
  | 'opted_in'
  | 'insight_recorded'
  | 'sentiment_updated'
  | 'cooldown_set'
  | 'email_delivered'
  | 'slack_dm_delivered'
  | 'preference_changed';

export interface PersonEvent {
  id: number;
  person_id: string;
  occurred_at: Date;
  event_type: PersonEventType;
  channel: string | null;
  data: Record<string, unknown>;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Record a person event. Append-only — never updates or deletes.
 */
export async function recordEvent(
  personId: string,
  eventType: PersonEventType,
  options: {
    channel?: string;
    data?: Record<string, unknown>;
    occurredAt?: Date;
  } = {}
): Promise<void> {
  await query(
    `INSERT INTO person_events (person_id, event_type, channel, data, occurred_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))`,
    [
      personId,
      eventType,
      options.channel ?? null,
      JSON.stringify(options.data ?? {}),
      options.occurredAt ?? null,
    ]
  );
}

/**
 * Record multiple events in a single INSERT (for backfill or batch operations).
 */
export async function recordEvents(
  events: Array<{
    personId: string;
    eventType: PersonEventType;
    channel?: string;
    data?: Record<string, unknown>;
    occurredAt?: Date;
  }>
): Promise<void> {
  if (events.length === 0) return;

  // Process in batches to avoid exceeding PostgreSQL parameter limits
  const BATCH_SIZE = 500;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const values: string[] = [];
    const params: unknown[] = [];

    for (const event of batch) {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, COALESCE($${base + 5}, NOW()))`);
      params.push(
        event.personId,
        event.eventType,
        event.channel ?? null,
        JSON.stringify(event.data ?? {}),
        event.occurredAt ?? null,
      );
    }

    await query(
      `INSERT INTO person_events (person_id, event_type, channel, data, occurred_at)
       VALUES ${values.join(', ')}`,
      params
    );
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function rowToEvent(row: Record<string, unknown>): PersonEvent {
  return {
    id: row.id as number,
    person_id: row.person_id as string,
    occurred_at: new Date(row.occurred_at as string),
    event_type: row.event_type as PersonEventType,
    channel: row.channel as string | null,
    data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>,
    created_at: new Date(row.created_at as string),
  };
}

/**
 * Get all events for a person, ordered chronologically.
 */
export async function getPersonTimeline(
  personId: string,
  options: {
    limit?: number;
    since?: Date;
    until?: Date;
    eventTypes?: PersonEventType[];
  } = {}
): Promise<PersonEvent[]> {
  let sql = `SELECT * FROM person_events WHERE person_id = $1`;
  const params: unknown[] = [personId];

  if (options.since) {
    params.push(options.since);
    sql += ` AND occurred_at >= $${params.length}`;
  }

  if (options.until) {
    params.push(options.until);
    sql += ` AND occurred_at <= $${params.length}`;
  }

  if (options.eventTypes && options.eventTypes.length > 0) {
    params.push(options.eventTypes);
    sql += ` AND event_type = ANY($${params.length})`;
  }

  sql += ` ORDER BY occurred_at ASC`;

  if (options.limit) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await query(sql, params);
  return result.rows.map(rowToEvent);
}

/**
 * Get recent events across all people (for admin dashboard / monitoring).
 */
export async function getRecentEvents(options: {
  limit?: number;
  eventTypes?: PersonEventType[];
  channel?: string;
}): Promise<PersonEvent[]> {
  let sql = `SELECT * FROM person_events WHERE 1=1`;
  const params: unknown[] = [];

  if (options.eventTypes && options.eventTypes.length > 0) {
    params.push(options.eventTypes);
    sql += ` AND event_type = ANY($${params.length})`;
  }

  if (options.channel) {
    params.push(options.channel);
    sql += ` AND channel = $${params.length}`;
  }

  sql += ` ORDER BY occurred_at DESC`;

  params.push(options.limit ?? 50);
  sql += ` LIMIT $${params.length}`;

  const result = await query(sql, params);
  return result.rows.map(rowToEvent);
}

/**
 * Count events for a person by type, optionally within a time window.
 */
export async function countEvents(
  personId: string,
  eventType: PersonEventType,
  options: { since?: Date } = {}
): Promise<number> {
  let sql = `SELECT COUNT(*) as count FROM person_events WHERE person_id = $1 AND event_type = $2`;
  const params: unknown[] = [personId, eventType];

  if (options.since) {
    params.push(options.since);
    sql += ` AND occurred_at >= $${params.length}`;
  }

  const result = await query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}
