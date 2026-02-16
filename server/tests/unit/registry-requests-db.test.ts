import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { RegistryRequestsDatabase } from '../../src/db/registry-requests-db.js';
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);

describe('RegistryRequestsDatabase', () => {
  let db: RegistryRequestsDatabase;

  beforeEach(() => {
    db = new RegistryRequestsDatabase();
    vi.clearAllMocks();
  });

  describe('trackRequest', () => {
    it('lowercases domain and includes entity_type', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: '', oid: 0, fields: [] });
      await db.trackRequest('brand', 'EXAMPLE.COM');
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO registry_requests'),
        ['brand', 'example.com']
      );
    });

    it('tracks property requests', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: '', oid: 0, fields: [] });
      await db.trackRequest('property', 'publisher.com');
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        ['property', 'publisher.com']
      );
    });
  });

  describe('markResolved', () => {
    it('returns true when a row is updated', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: '', oid: 0, fields: [] });
      const result = await db.markResolved('brand', 'example.com', 'canonical.com');
      expect(result).toBe(true);
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE registry_requests'),
        ['brand', 'example.com', 'canonical.com']
      );
    });

    it('returns false when no matching unresolved row exists', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      const result = await db.markResolved('brand', 'unknown.com', 'canonical.com');
      expect(result).toBe(false);
    });

    it('lowercases both domains', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: '', oid: 0, fields: [] });
      await db.markResolved('property', 'EXAMPLE.COM', 'CANONICAL.COM');
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['property', 'example.com', 'canonical.com']
      );
    });
  });

  describe('listUnresolved', () => {
    it('returns requests ordered by count descending', async () => {
      const now = new Date();
      mockedQuery.mockResolvedValueOnce({
        rows: [
          { entity_type: 'brand', domain: 'popular.com', request_count: 50, first_requested_at: now, last_requested_at: now, resolved_at: null, resolved_to_domain: null },
          { entity_type: 'brand', domain: 'less.com', request_count: 5, first_requested_at: now, last_requested_at: now, resolved_at: null, resolved_to_domain: null },
        ],
        rowCount: 2, command: '', oid: 0, fields: [],
      });

      const requests = await db.listUnresolved('brand', { limit: 10, offset: 0 });
      expect(requests).toHaveLength(2);
      expect(requests[0].domain).toBe('popular.com');
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE entity_type = $1 AND resolved_at IS NULL'),
        ['brand', 10, 0]
      );
    });

    it('caps limit at 200', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      await db.listUnresolved('property', { limit: 500 });
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['property', 200, 0]
      );
    });

    it('defaults to limit 50 offset 0', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      await db.listUnresolved('brand');
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['brand', 50, 0]
      );
    });
  });

  describe('getStats', () => {
    it('returns aggregated statistics', async () => {
      const now = new Date();
      mockedQuery
        .mockResolvedValueOnce({ rows: [{ count: '42' }], rowCount: 1, command: '', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ count: '10' }], rowCount: 1, command: '', oid: 0, fields: [] })
        .mockResolvedValueOnce({
          rows: [{ domain: 'top.com', request_count: 100, last_requested_at: now }],
          rowCount: 1, command: '', oid: 0, fields: [],
        });

      const stats = await db.getStats('brand');
      expect(stats.total_unresolved).toBe(42);
      expect(stats.total_resolved).toBe(10);
      expect(stats.top_requested).toHaveLength(1);
      expect(stats.top_requested[0].domain).toBe('top.com');
    });

    it('filters by entity_type', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1, command: '', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1, command: '', oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

      await db.getStats('property');

      for (const call of mockedQuery.mock.calls) {
        expect(call[1]?.[0]).toBe('property');
      }
    });
  });
});
