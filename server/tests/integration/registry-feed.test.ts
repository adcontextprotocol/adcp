import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CatalogEventsDatabase, type WriteEventInput } from '../../src/db/catalog-events-db.js';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '../../src/db/uuid.js';

describe('Registry Feed Integration Tests', () => {
  let pool: Pool;
  let eventsDb: CatalogEventsDatabase;
  const runId = randomUUID().replaceAll('-', '');
  const namespace = `fixture_${runId}`;
  const nearNamespace = `fixturex${runId}`; // Must not match the literal underscore.
  const foreignNamespace = `foreign_${runId}`;
  const actor = `feed-fixture:${runId}`;

  async function writeForeignTypePressure() {
    return eventsDb.writeEvents([
      { event_type: `${foreignNamespace}.property.created`, entity_type: 'property', entity_id: 'foreign-property', actor },
      { event_type: `${foreignNamespace}.agent.discovered`, entity_type: 'agent', entity_id: 'foreign-agent', actor },
      { event_type: `${nearNamespace}.property.created`, entity_type: 'property', entity_id: 'underscore-decoy-property', actor },
      { event_type: `${nearNamespace}.agent.discovered`, entity_type: 'agent', entity_id: 'underscore-decoy-agent', actor },
    ]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    eventsDb = new CatalogEventsDatabase();
  });

  afterAll(async () => {
    // Delete only this run's exact owned actor, including pressure decoys.
    await pool.query('DELETE FROM catalog_events WHERE actor = $1', [actor]);
    await closeDatabase();
  });

  beforeEach(async () => {
    // Delete only this run's exact owned actor, including pressure decoys.
    await pool.query('DELETE FROM catalog_events WHERE actor = $1', [actor]);
  });

  // ── Write & Read Round-trip ──────────────────────────────────────

  describe('write and query round-trip', () => {
    it('writes a single event and reads it back', async () => {
      const eventId = await eventsDb.writeEvent({
        event_type: 'property.created',
        entity_type: 'property',
        entity_id: 'rid-001',
        payload: { source: 'test' },
        actor,
      });

      expect(eventId).toBeTruthy();
      expect(eventId).toMatch(/^[0-9a-f]{8}-/); // UUID format

      const feed = await eventsDb.queryFeed(null, null);
      if ('error' in feed) throw new Error(feed.message);

      // Filter to this file's events; concurrent test files writing
      // events via DB triggers (actor='trigger:*') could otherwise
      // interleave.
      const ours = feed.events.filter(e => e.actor === actor);
      expect(ours).toHaveLength(1);
      expect(ours[0].event_id).toBe(eventId);
      expect(ours[0].event_type).toBe('property.created');
      expect(ours[0].entity_id).toBe('rid-001');
      expect(ours[0].payload).toEqual({ source: 'test' });
      expect(ours[0].actor).toBe(actor);
    });

    it('writes multiple events in a transaction', async () => {
      const inputs: WriteEventInput[] = [
        { event_type: `${namespace}.agent.discovered`, entity_type: 'agent', entity_id: 'url-1', actor },
        { event_type: `${namespace}.agent.discovered`, entity_type: 'agent', entity_id: 'url-2', actor },
        { event_type: `${namespace}.authorization.granted`, entity_type: 'authorization', entity_id: 'a:b', actor },
      ];

      const ids = await eventsDb.writeEvents(inputs);
      expect(ids).toHaveLength(3);

      const feed = await eventsDb.queryFeed(null, [`${namespace}.*`]);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(3);
      expect(feed.events.map(event => event.event_id)).toEqual([...ids].sort());
    });
  });

  // ── Cursor Pagination ───────────────────────────────────────────

  describe('cursor pagination', () => {
    it('paginates through events using cursor', async () => {
      // Write 5 owned events plus matching entity types under other namespaces.
      const seededIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        seededIds.push(await eventsDb.writeEvent({
          event_type: `${namespace}.property.created`,
          entity_type: 'property',
          entity_id: `rid-${i}`,
          actor,
        }));
      }
      await writeForeignTypePressure();

      // The SQL type predicate must isolate this run; keep raw pagination results.
      const pcOnly = [`${namespace}.property.created`];

      // Page 1: first 2
      const page1 = await eventsDb.queryFeed(null, pcOnly, 2);
      if ('error' in page1) throw new Error(page1.message);
      expect(page1.events).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeTruthy();

      // Page 2: next 2
      const page2 = await eventsDb.queryFeed(page1.cursor, pcOnly, 2);
      if ('error' in page2) throw new Error(page2.message);
      expect(page2.events).toHaveLength(2);
      expect(page2.has_more).toBe(true);

      // Page 3: last 1
      const page3 = await eventsDb.queryFeed(page2.cursor, pcOnly, 2);
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
      expect(allIds).toEqual([...seededIds].sort());
    });

    it('returns events in UUID v7 order (creation time)', async () => {
      await writeForeignTypePressure();
      for (let i = 0; i < 3; i++) {
        await eventsDb.writeEvent({
          event_type: `${namespace}.property.created`,
          entity_type: 'property',
          entity_id: `ordered-${i}`,
          actor,
        });
        // Small delay to ensure distinct timestamps
        await new Promise(r => setTimeout(r, 5));
      }

      // The exact run type excludes foreign and underscore near-match decoys.
      const feed = await eventsDb.queryFeed(null, [`${namespace}.property.created`]);
      if ('error' in feed) throw new Error(feed.message);

      expect(feed.events).toHaveLength(3);
      expect(feed.events[0].entity_id).toBe('ordered-0');
      expect(feed.events[1].entity_id).toBe('ordered-1');
      expect(feed.events[2].entity_id).toBe('ordered-2');
    });
  });

  // ── Type Glob Filtering ─────────────────────────────────────────

  describe('type glob filtering', () => {
    let seededIds: string[];
    beforeEach(async () => {
      seededIds = await eventsDb.writeEvents([
        { event_type: `${namespace}.property.created`, entity_type: 'property', entity_id: 'p1', actor },
        { event_type: `${namespace}.property.updated`, entity_type: 'property', entity_id: 'p2', actor },
        { event_type: `${namespace}.property.merged`, entity_type: 'property', entity_id: 'p3', actor },
        { event_type: `${namespace}.agent.discovered`, entity_type: 'agent', entity_id: 'a1', actor },
        { event_type: `${namespace}.authorization.granted`, entity_type: 'authorization', entity_id: 'z1', actor },
      ]);
      await writeForeignTypePressure();
    });

    it('filters by exact event type', async () => {
      const feed = await eventsDb.queryFeed(null, [`${namespace}.property.created`]);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(1);
      expect(feed.events[0].event_type).toBe(`${namespace}.property.created`);
    });

    it('filters by glob pattern', async () => {
      const feed = await eventsDb.queryFeed(null, [`${namespace}.property.*`]);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(3);
      expect(feed.events.every(e => e.event_type.startsWith(`${namespace}.property.`))).toBe(true);
    });

    it('combines multiple type filters with OR', async () => {
      const feed = await eventsDb.queryFeed(null, [`${namespace}.property.*`, `${namespace}.agent.*`]);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(4);
      const expectedTypes = [
        `${namespace}.property.created`, `${namespace}.property.updated`,
        `${namespace}.property.merged`, `${namespace}.agent.discovered`,
      ];
      const expected = seededIds.slice(0, 4).map((id, index) => ({ id, type: expectedTypes[index] }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(feed.events.map(event => ({ id: event.event_id, type: event.event_type }))).toEqual(expected);
    });

    it('returns empty for non-matching type', async () => {
      const feed = await eventsDb.queryFeed(null, [`${namespace}.nonexistent.*`]);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(0);
      expect(feed.has_more).toBe(false);
    });
  });

  // ── Empty Feed ──────────────────────────────────────────────────

  describe('empty feed', () => {
    it('returns empty events with null cursor when no events exist', async () => {
      // Filter to a never-emitted event_type so concurrent test files
      // writing to catalog_events can't make this assertion racy.
      const feed = await eventsDb.queryFeed(null, [`${namespace}.nonexistent.never_emitted`]);
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
        [uuidv7(), `${namespace}.old.event`, 'test', 'old-1', '{}', actor]
      );

      // Insert a recent event
      await eventsDb.writeEvent({
        event_type: `${namespace}.recent.event`,
        entity_type: 'test',
        entity_id: 'recent-1',
        actor,
      });

      const deleted = await eventsDb.cleanup(90);
      // Concurrent test files may also have stale events; assert at
      // least 1 (our seeded one) was deleted, not exactly 1.
      expect(deleted).toBeGreaterThanOrEqual(1);

      // Recent event should still exist among any concurrent writes.
      const feed = await eventsDb.queryFeed(null, [`${namespace}.recent.event`]);
      if ('error' in feed) throw new Error(feed.message);
      expect(feed.events).toHaveLength(1);
      expect(feed.events[0].event_type).toBe(`${namespace}.recent.event`);
    });
  });
});
