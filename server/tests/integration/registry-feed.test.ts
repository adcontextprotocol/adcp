import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CatalogEventsDatabase, type WriteEventInput } from '../../src/db/catalog-events-db.js';
import type { Pool } from 'pg';

describe('Registry Feed Integration Tests', () => {
  let pool: Pool;
  let eventsDb: CatalogEventsDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    eventsDb = new CatalogEventsDatabase();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM catalog_events');
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM catalog_events');
  });

  // ── Write & Read Round-trip ──────────────────────────────────────

  describe('write and query round-trip', () => {
    it('writes a single event and reads it back', async () => {
      const eventId = await eventsDb.writeEvent({
        event_type: 'property.created',
        entity_type: 'property',
        entity_id: 'rid-001',
        payload: { source: 'test' },
        actor: 'test:integration',
      });

      expect(eventId).toBeTruthy();
      expect(eventId).toMatch(/^[0-9a-f]{8}-/); // UUID format

      const feed = await eventsDb.queryFeed(null, null);
      if ('error' in feed) throw new Error(feed.message);

      expect(feed.events).toHaveLength(1);
      expect(feed.events[0].event_id).toBe(eventId);
      expect(feed.events[0].event_type).toBe('property.created');
      expect(feed.events[0].entity_id).toBe('rid-001');
      expect(feed.events[0].payload).toEqual({ source: 'test' });
      expect(feed.events[0].actor).toBe('test:integration');
    });

    it('writes multiple events in a transaction', async () => {
      const inputs: WriteEventInput[] = [
        { event_type: 'agent.discovered', entity_type: 'agent', entity_id: 'url-1', actor: 'test' },
        { event_type: 'agent.discovered', entity_type: 'agent', entity_id: 'url-2', actor: 'test' },
        { event_type: 'authorization.granted', entity_type: 'authorization', entity_id: 'a:b', actor: 'test' },
      ];

      const ids = await eventsDb.writeEvents(inputs);
      expect(ids).toHaveLength(3);

      const feed = await eventsDb.queryFeed(null, null);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(3);
    });
  });

  // ── Cursor Pagination ───────────────────────────────────────────

  describe('cursor pagination', () => {
    it('paginates through events using cursor', async () => {
      // Write 5 events
      for (let i = 0; i < 5; i++) {
        await eventsDb.writeEvent({
          event_type: 'property.created',
          entity_type: 'property',
          entity_id: `rid-${i}`,
          actor: 'test',
        });
      }

      // Page 1: first 2
      const page1 = await eventsDb.queryFeed(null, null, 2);
      if ('error' in page1) throw new Error(page1.message);
      expect(page1.events).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeTruthy();

      // Page 2: next 2
      const page2 = await eventsDb.queryFeed(page1.cursor, null, 2);
      if ('error' in page2) throw new Error(page2.message);
      expect(page2.events).toHaveLength(2);
      expect(page2.has_more).toBe(true);

      // Page 3: last 1
      const page3 = await eventsDb.queryFeed(page2.cursor, null, 2);
      if ('error' in page3) throw new Error(page3.message);
      expect(page3.events).toHaveLength(1);
      expect(page3.has_more).toBe(false);

      // Verify pages are disjoint
      const allIds = [
        ...page1.events.map(e => e.event_id),
        ...page2.events.map(e => e.event_id),
        ...page3.events.map(e => e.event_id),
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(5);
    });

    it('returns events in UUID v7 order (creation time)', async () => {
      for (let i = 0; i < 3; i++) {
        await eventsDb.writeEvent({
          event_type: 'property.created',
          entity_type: 'property',
          entity_id: `ordered-${i}`,
          actor: 'test',
        });
        // Small delay to ensure distinct timestamps
        await new Promise(r => setTimeout(r, 5));
      }

      const feed = await eventsDb.queryFeed(null, null);
      if ('error' in feed) throw new Error(feed.message);

      expect(feed.events[0].entity_id).toBe('ordered-0');
      expect(feed.events[1].entity_id).toBe('ordered-1');
      expect(feed.events[2].entity_id).toBe('ordered-2');
    });
  });

  // ── Type Glob Filtering ─────────────────────────────────────────

  describe('type glob filtering', () => {
    beforeEach(async () => {
      await eventsDb.writeEvents([
        { event_type: 'property.created', entity_type: 'property', entity_id: 'p1', actor: 'test' },
        { event_type: 'property.updated', entity_type: 'property', entity_id: 'p2', actor: 'test' },
        { event_type: 'property.merged', entity_type: 'property', entity_id: 'p3', actor: 'test' },
        { event_type: 'agent.discovered', entity_type: 'agent', entity_id: 'a1', actor: 'test' },
        { event_type: 'authorization.granted', entity_type: 'authorization', entity_id: 'z1', actor: 'test' },
      ]);
    });

    it('filters by exact event type', async () => {
      const feed = await eventsDb.queryFeed(null, ['property.created']);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(1);
      expect(feed.events[0].event_type).toBe('property.created');
    });

    it('filters by glob pattern', async () => {
      const feed = await eventsDb.queryFeed(null, ['property.*']);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(3);
      expect(feed.events.every(e => e.event_type.startsWith('property.'))).toBe(true);
    });

    it('combines multiple type filters with OR', async () => {
      const feed = await eventsDb.queryFeed(null, ['property.*', 'agent.*']);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(4);
    });

    it('returns empty for non-matching type', async () => {
      const feed = await eventsDb.queryFeed(null, ['nonexistent.*']);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(0);
      expect(feed.has_more).toBe(false);
    });
  });

  // ── Empty Feed ──────────────────────────────────────────────────

  describe('empty feed', () => {
    it('returns empty events with null cursor when no events exist', async () => {
      const feed = await eventsDb.queryFeed(null, null);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(0);
      expect(feed.cursor).toBeNull();
      expect(feed.has_more).toBe(false);
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('deletes events older than retention window', async () => {
      // Insert an event with old created_at
      await pool.query(
        `INSERT INTO catalog_events (event_id, event_type, entity_type, entity_id, payload, actor, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '100 days')`,
        ['00000000-0000-7000-8000-000000000001', 'old.event', 'test', 'old-1', '{}', 'test']
      );

      // Insert a recent event
      await eventsDb.writeEvent({
        event_type: 'recent.event',
        entity_type: 'test',
        entity_id: 'recent-1',
        actor: 'test',
      });

      const deleted = await eventsDb.cleanup(90);
      expect(deleted).toBe(1);

      // Recent event should still exist
      const feed = await eventsDb.queryFeed(null, null);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(1);
      expect(feed.events[0].event_type).toBe('recent.event');
    });
  });
});
