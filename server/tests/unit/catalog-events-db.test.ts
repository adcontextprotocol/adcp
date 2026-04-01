import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/client.js')>();
  return {
    query: vi.fn(),
    getClient: vi.fn(),
    escapeLikePattern: actual.escapeLikePattern,
  };
});

vi.mock('../../src/db/uuid.js', () => ({
  uuidv7: vi.fn(),
}));

import { CatalogEventsDatabase } from '../../src/db/catalog-events-db.js';
import { query, getClient } from '../../src/db/client.js';
import { uuidv7 } from '../../src/db/uuid.js';

const mockedQuery = vi.mocked(query);
const mockedGetClient = vi.mocked(getClient);
const mockedUuidv7 = vi.mocked(uuidv7);

const EMPTY_RESULT = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

function mockResult<T>(rows: T[], rowCount?: number) {
  return { rows, rowCount: rowCount ?? rows.length, command: '', oid: 0, fields: [] };
}

describe('CatalogEventsDatabase', () => {
  let db: CatalogEventsDatabase;

  beforeEach(() => {
    db = new CatalogEventsDatabase();
    vi.clearAllMocks();
    mockedUuidv7.mockReturnValue('019...-event-001');
  });

  // ── writeEvent ──────────────────────────────────────────────────────────

  describe('writeEvent', () => {
    it('inserts with generated UUID v7 and returns event_id', async () => {
      mockedQuery.mockResolvedValueOnce(EMPTY_RESULT);

      const id = await db.writeEvent({
        event_type: 'property.created',
        entity_type: 'property',
        entity_id: 'rid-123',
        payload: { source: 'crawl' },
        actor: 'pipeline:crawler',
      });

      expect(id).toBe('019...-event-001');
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO catalog_events'),
        ['019...-event-001', 'property.created', 'property', 'rid-123', '{"source":"crawl"}', 'pipeline:crawler']
      );
    });

    it('defaults payload to empty object', async () => {
      mockedQuery.mockResolvedValueOnce(EMPTY_RESULT);

      await db.writeEvent({
        event_type: 'agent.discovered',
        entity_type: 'agent',
        entity_id: 'https://agent.example.com',
        actor: 'pipeline:crawler',
      });

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['{}'])
      );
    });

    it('uses provided client for transactional writes', async () => {
      const mockClient = { query: vi.fn() };

      await db.writeEvent({
        event_type: 'property.updated',
        entity_type: 'property',
        entity_id: 'rid-456',
        actor: 'member:m1',
      }, mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO catalog_events'),
        expect.arrayContaining(['property.updated'])
      );
      // Pool query should NOT be called when client is provided
      expect(mockedQuery).not.toHaveBeenCalled();
    });
  });

  // ── writeEvents ─────────────────────────────────────────────────────────

  describe('writeEvents', () => {
    it('returns empty array for empty input', async () => {
      const ids = await db.writeEvents([]);
      expect(ids).toEqual([]);
      expect(mockedGetClient).not.toHaveBeenCalled();
    });

    it('wraps multiple writes in a transaction', async () => {
      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      mockedGetClient.mockResolvedValueOnce(mockClient as any);
      mockedUuidv7.mockReturnValueOnce('id-1').mockReturnValueOnce('id-2');

      const ids = await db.writeEvents([
        { event_type: 'property.created', entity_type: 'property', entity_id: 'r1', actor: 'test' },
        { event_type: 'property.merged', entity_type: 'property', entity_id: 'r2', actor: 'test' },
      ]);

      expect(ids).toEqual(['id-1', 'id-2']);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back on error', async () => {
      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      mockedGetClient.mockResolvedValueOnce(mockClient as any);
      // First write succeeds, second fails
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // first INSERT
        .mockRejectedValueOnce(new Error('db error')); // second INSERT

      await expect(db.writeEvents([
        { event_type: 'a.b', entity_type: 'a', entity_id: '1', actor: 'test' },
        { event_type: 'c.d', entity_type: 'c', entity_id: '2', actor: 'test' },
      ])).rejects.toThrow('db error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ── queryFeed ───────────────────────────────────────────────────────────

  describe('queryFeed', () => {
    it('returns events ordered by event_id with cursor', async () => {
      const now = new Date();
      const events = [
        { event_id: 'e1', event_type: 'property.created', entity_type: 'property', entity_id: 'r1', payload: {}, actor: 'test', created_at: now },
        { event_id: 'e2', event_type: 'property.updated', entity_type: 'property', entity_id: 'r2', payload: {}, actor: 'test', created_at: now },
      ];

      // cursor expiration check (single query, status=valid)
      mockedQuery.mockResolvedValueOnce(mockResult([{ status: 'valid' }]));
      // feed query (2 rows, no extra = has_more false)
      mockedQuery.mockResolvedValueOnce(mockResult(events));

      const result = await db.queryFeed('cursor-abc', null, 100);

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.events).toHaveLength(2);
        expect(result.cursor).toBe('e2');
        expect(result.has_more).toBe(false);
      }
    });

    it('detects has_more when result exceeds limit', async () => {
      const events = Array.from({ length: 4 }, (_, i) => ({
        event_id: `e${i}`, event_type: 'property.created', entity_type: 'property',
        entity_id: `r${i}`, payload: {}, actor: 'test', created_at: new Date(),
      }));

      // No cursor — skip expiration checks, go straight to feed query
      mockedQuery.mockResolvedValueOnce(mockResult(events)); // 4 rows for limit=3

      const result = await db.queryFeed(null, null, 3);

      if (!('error' in result)) {
        expect(result.events).toHaveLength(3);
        expect(result.has_more).toBe(true);
        expect(result.cursor).toBe('e2');
      }
    });

    it('returns null cursor when no events and no prior cursor', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      const result = await db.queryFeed(null, null);

      if (!('error' in result)) {
        expect(result.events).toHaveLength(0);
        expect(result.cursor).toBeNull();
        expect(result.has_more).toBe(false);
      }
    });

    it('applies type glob filter', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.queryFeed(null, ['property.*']);

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('event_type LIKE'),
        expect.arrayContaining(['property.%'])
      );
    });

    it('supports multiple type globs with OR', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.queryFeed(null, ['property.*', 'agent.*']);

      const sql = mockedQuery.mock.calls[0][0] as string;
      // Should have two LIKE conditions joined by OR
      expect(sql).toContain('event_type LIKE');
      expect(sql).toContain(' OR ');
      const params = mockedQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('property.%');
      expect(params).toContain('agent.%');
    });

    it('caps limit at 10000', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.queryFeed(null, null, 50_000);

      const params = mockedQuery.mock.calls[0][1] as unknown[];
      // Last param is limit+1 = 10001
      expect(params[params.length - 1]).toBe(10_001);
    });

    it('defaults limit to 100', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.queryFeed(null, null);

      const params = mockedQuery.mock.calls[0][1] as unknown[];
      expect(params[params.length - 1]).toBe(101);
    });

    it('returns cursor_expired for old cursors', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([{ status: 'expired' }]));

      const result = await db.queryFeed('old-cursor', null);

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('cursor_expired');
        expect(result.message).toContain('Re-bootstrap');
      }
    });

    it('returns cursor_expired for unknown cursors (deleted by cleanup)', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([{ status: 'unknown' }]));

      const result = await db.queryFeed('deleted-cursor', null);

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('cursor_expired');
      }
    });
  });

  // ── cleanup ─────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('deletes events older than retention window in batches', async () => {
      // First batch returns 42 (less than 5000 batch size), so loop ends
      mockedQuery.mockResolvedValueOnce(mockResult([], 42));

      const deleted = await db.cleanup(30);

      expect(deleted).toBe(42);
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining("INTERVAL '1 day' * $1"),
        [30, 5000]
      );
    });

    it('loops when batch is full', async () => {
      // First batch returns 5000 (full batch), loop continues
      mockedQuery.mockResolvedValueOnce(mockResult([], 5000));
      // Second batch returns 100 (partial), loop ends
      mockedQuery.mockResolvedValueOnce(mockResult([], 100));

      const deleted = await db.cleanup(30);

      expect(deleted).toBe(5100);
      expect(mockedQuery).toHaveBeenCalledTimes(2);
    });

    it('defaults to 90-day retention', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([], 0));

      await db.cleanup();

      expect(mockedQuery).toHaveBeenCalledWith(expect.any(String), [90, 5000]);
    });

    it('returns 0 when no events to clean', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([], 0));

      const deleted = await db.cleanup();
      expect(deleted).toBe(0);
    });
  });
});
