import { query, getClient } from './client.js';
import { uuidv7 } from './uuid.js';
import { createLogger } from '../logger.js';

const logger = createLogger('catalog-events-db');

const MAX_FEED_LIMIT = 10_000;
const DEFAULT_FEED_LIMIT = 100;
const RETENTION_DAYS_DEFAULT = 90;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CatalogEvent {
  event_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  actor: string;
  created_at: Date;
}

export interface WriteEventInput {
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload?: Record<string, unknown>;
  actor: string;
}

export interface FeedResult {
  events: CatalogEvent[];
  cursor: string | null;
  has_more: boolean;
}

export interface FeedError {
  error: 'cursor_expired';
  message: string;
}

// ─── Database ────────────────────────────────────────────────────────────────

export class CatalogEventsDatabase {

  /**
   * Write a single event with a generated UUID v7 event_id.
   * Call this inside an existing transaction by passing the client directly,
   * or let it run against the pool for standalone writes.
   */
  async writeEvent(input: WriteEventInput, client?: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<string> {
    const eventId = uuidv7();
    const sql = `INSERT INTO catalog_events (event_id, event_type, entity_type, entity_id, payload, actor)
       VALUES ($1, $2, $3, $4, $5, $6)`;
    const params = [eventId, input.event_type, input.entity_type, input.entity_id, JSON.stringify(input.payload ?? {}), input.actor];

    if (client) {
      await client.query(sql, params);
    } else {
      await query(sql, params);
    }
    return eventId;
  }

  /**
   * Write multiple events in a single transaction.
   */
  async writeEvents(inputs: WriteEventInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const ids: string[] = [];
      for (const input of inputs) {
        const id = await this.writeEvent(input, client);
        ids.push(id);
      }
      await client.query('COMMIT');
      return ids;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Query the event feed. Returns events after the given cursor, ordered by event_id.
   *
   * Type filtering supports glob patterns: 'property.*' matches 'property.created', etc.
   * Returns `cursor_expired` error if the cursor is older than the retention window.
   */
  async queryFeed(
    cursor: string | null,
    types: string[] | null,
    limit?: number
  ): Promise<FeedResult | FeedError> {
    const effectiveLimit = Math.min(Math.max(1, limit ?? DEFAULT_FEED_LIMIT), MAX_FEED_LIMIT);

    // Check cursor expiration with a single point lookup
    if (cursor) {
      const check = await query<{ status: string }>(
        `SELECT CASE
          WHEN NOT EXISTS(SELECT 1 FROM catalog_events WHERE event_id = $1) THEN 'unknown'
          WHEN EXISTS(SELECT 1 FROM catalog_events WHERE event_id = $1 AND created_at < NOW() - INTERVAL '1 day' * $2) THEN 'expired'
          ELSE 'valid'
        END AS status`,
        [cursor, RETENTION_DAYS_DEFAULT]
      );
      if (check.rows[0].status === 'expired' || check.rows[0].status === 'unknown') {
        return {
          error: 'cursor_expired',
          message: `Cursor is older than ${RETENTION_DAYS_DEFAULT}-day retention window. Re-bootstrap from /registry/agents/search and /catalog/sync.`,
        };
      }
    }

    // Build query
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (cursor) {
      conditions.push(`event_id > $${paramIdx}`);
      params.push(cursor);
      paramIdx++;
    }

    if (types && types.length > 0) {
      const typeConditions = types.map(t => {
        const pattern = t.replace(/\*/g, '%');
        params.push(pattern);
        return `event_type LIKE $${paramIdx++}`;
      });
      conditions.push(`(${typeConditions.join(' OR ')})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Fetch limit+1 to determine has_more
    const result = await query<CatalogEvent>(
      `SELECT event_id, event_type, entity_type, entity_id, payload, actor, created_at
       FROM catalog_events
       ${where}
       ORDER BY event_id
       LIMIT $${paramIdx}`,
      [...params, effectiveLimit + 1]
    );

    const hasMore = result.rows.length > effectiveLimit;
    const events = hasMore ? result.rows.slice(0, effectiveLimit) : result.rows;
    const lastCursor = events.length > 0 ? events[events.length - 1].event_id : cursor;

    return { events, cursor: lastCursor, has_more: hasMore };
  }

  /**
   * Delete events older than the retention window.
   */
  async cleanup(retentionDays: number = RETENTION_DAYS_DEFAULT): Promise<number> {
    const BATCH_SIZE = 5000;
    let totalDeleted = 0;
    let batchDeleted: number;

    // Delete in batches to avoid long-running transactions and dead-tuple bloat
    do {
      const result = await query(
        `DELETE FROM catalog_events
         WHERE event_id IN (
           SELECT event_id FROM catalog_events
           WHERE created_at < NOW() - INTERVAL '1 day' * $1
           ORDER BY event_id
           LIMIT $2
         )`,
        [retentionDays, BATCH_SIZE]
      );
      batchDeleted = result.rowCount ?? 0;
      totalDeleted += batchDeleted;
    } while (batchDeleted === BATCH_SIZE);

    if (totalDeleted > 0) {
      logger.info(`Cleaned up ${totalDeleted} catalog events older than ${retentionDays} days`);
    }
    return totalDeleted;
  }
}
