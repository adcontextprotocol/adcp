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
  | 'email_opened'
  | 'email_clicked'
  | 'email_bounced'
  | 'slack_dm_delivered'
  | 'preference_changed'
  | 'admin_nudge_requested'
  | 'invite_sent'           // membership invite emailed to recipient
  | 'invite_accepted'       // recipient signed in and accepted
  | 'invite_revoked'        // admin revoked before accept
  | 'invite_expired'        // expires_at passed without accept/revoke (sweep)
  | 'tool_error';           // an Addie tool refused / errored — data carries { tool, reason, ... }

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
 * Cap stored message text at 64KB (UTF-8 byte count). Slack messages are
 * theoretically capped at 40KB by the platform; web chat has no upstream
 * limit. Matching the limit here keeps a single 50KB paste from inflating
 * timeline reads. Returns the (possibly truncated) text and a flag.
 *
 * `original_length` is the JS `string.length` of the input — UTF-16 code
 * units, not bytes or codepoints. This matches the `text_length` convention
 * already in use across `message_sent` and prior `message_received` writes;
 * it does NOT match the cap units (the cap is in bytes, length is in code
 * units). For an emoji-heavy payload, length will exceed byte count / 4.
 */
const MAX_EVENT_TEXT_BYTES = 64 * 1024;

export function capEventText(text: string): {
  text: string;
  truncated: boolean;
  original_length: number;
} {
  const original_length = text.length;
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= MAX_EVENT_TEXT_BYTES) {
    return { text, truncated: false, original_length };
  }
  // Truncate on a UTF-8 boundary
  const trimmed = buf.subarray(0, MAX_EVENT_TEXT_BYTES).toString('utf8');
  return { text: trimmed, truncated: true, original_length };
}

/**
 * Build the `data` payload for a `message_received` event from a sanitized
 * inbound text plus the source label (e.g. 'dm', 'web_chat'). Centralizes the
 * cap + text + text_length + truncated shape so the four write sites
 * (Slack handler, Slack bolt-app DM/assistant-thread, two web chat handlers)
 * stay in lockstep.
 */
export function buildMessageReceivedData(
  text: string,
  source: string
): Record<string, unknown> {
  const capped = capEventText(text);
  return {
    source,
    text: capped.text,
    text_length: capped.original_length,
    ...(capped.truncated ? { truncated: true } : {}),
  };
}

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

export type InviteEventType = Extract<
  PersonEventType,
  'invite_sent' | 'invite_accepted' | 'invite_revoked' | 'invite_expired'
>;

/**
 * Record a membership-invite lifecycle event, deduplicated on (event_type, invite_id).
 * Safe to call repeatedly — relies on the partial unique index from migration 458.
 * Returns true if a new row was inserted, false if the dedupe index skipped it.
 */
export async function recordInviteEvent(
  personId: string,
  eventType: InviteEventType,
  inviteId: string,
  options: {
    data?: Record<string, unknown>;
    occurredAt?: Date;
  } = {}
): Promise<boolean> {
  const data = { ...(options.data ?? {}), invite_id: inviteId };
  // The WHERE clause below must match the predicate of idx_person_events_invite_dedupe
  // (migration 458) exactly — otherwise PG can't pick the partial unique index and
  // the insert silently stops being idempotent. Keep both lists in lockstep.
  const result = await query(
    `INSERT INTO person_events (person_id, event_type, channel, data, occurred_at)
     VALUES ($1, $2, 'system', $3::jsonb, COALESCE($4, NOW()))
     ON CONFLICT (event_type, ((data->>'invite_id')))
     WHERE event_type IN ('invite_sent', 'invite_accepted', 'invite_revoked', 'invite_expired')
     DO NOTHING`,
    [personId, eventType, JSON.stringify(data), options.occurredAt ?? null]
  );
  return (result.rowCount ?? 0) > 0;
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
