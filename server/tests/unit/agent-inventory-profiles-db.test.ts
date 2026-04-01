import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { AgentInventoryProfilesDatabase } from '../../src/db/agent-inventory-profiles-db.js';
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);

const EMPTY_RESULT = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

function mockResult<T>(rows: T[], rowCount?: number) {
  return { rows, rowCount: rowCount ?? rows.length, command: '', oid: 0, fields: [] };
}

describe('AgentInventoryProfilesDatabase', () => {
  let db: AgentInventoryProfilesDatabase;

  beforeEach(() => {
    db = new AgentInventoryProfilesDatabase();
    vi.clearAllMocks();
  });

  // ── upsertProfile ───────────────────────────────────────────────

  describe('upsertProfile', () => {
    it('inserts with ON CONFLICT UPDATE', async () => {
      mockedQuery.mockResolvedValueOnce(EMPTY_RESULT);

      await db.upsertProfile({
        agent_url: 'https://agent.example.com',
        channels: ['ctv', 'olv'],
        markets: ['US', 'CA'],
        property_count: 10,
        has_tmp: true,
      });

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT (agent_url) DO UPDATE'),
        expect.arrayContaining(['https://agent.example.com', ['ctv', 'olv'], ['US', 'CA']])
      );
    });

    it('defaults arrays to empty and counts to zero', async () => {
      mockedQuery.mockResolvedValueOnce(EMPTY_RESULT);

      await db.upsertProfile({ agent_url: 'https://minimal.example.com' });

      const params = mockedQuery.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe('https://minimal.example.com');
      expect(params[1]).toEqual([]); // channels
      expect(params[2]).toEqual([]); // property_types
      expect(params[3]).toEqual([]); // markets
      expect(params[8]).toBe(0);     // property_count
      expect(params[9]).toBe(0);     // publisher_count
      expect(params[10]).toBe(false); // has_tmp
    });
  });

  // ── getProfile ──────────────────────────────────────────────────

  describe('getProfile', () => {
    it('returns profile when found', async () => {
      const profile = {
        agent_url: 'https://agent.example.com',
        channels: ['ctv'],
        property_types: ['ctv_app'],
        markets: ['US'],
        categories: [],
        tags: [],
        delivery_types: ['direct'],
        format_ids: [],
        property_count: 5,
        publisher_count: 2,
        has_tmp: true,
        category_taxonomy: null,
        updated_at: new Date(),
      };
      mockedQuery.mockResolvedValueOnce(mockResult([profile]));

      const result = await db.getProfile('https://agent.example.com');
      expect(result).toEqual(profile);
    });

    it('returns null when not found', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));
      const result = await db.getProfile('https://unknown.example.com');
      expect(result).toBeNull();
    });
  });

  // ── search ──────────────────────────────────────────────────────

  describe('search', () => {
    it('uses array overlap (&&) for filter dimensions', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({ channels: ['ctv', 'olv'] });

      const sql = mockedQuery.mock.calls[0][0] as string;
      expect(sql).toContain('channels && $1');
      const params = mockedQuery.mock.calls[0][1] as unknown[];
      expect(params[0]).toEqual(['ctv', 'olv']);
    });

    it('combines multiple filter dimensions with AND', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({ channels: ['ctv'], markets: ['US'] });

      const sql = mockedQuery.mock.calls[0][0] as string;
      expect(sql).toContain('channels && $1');
      expect(sql).toContain('markets && $2');
    });

    it('applies has_tmp boolean filter', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({ has_tmp: true });

      const sql = mockedQuery.mock.calls[0][0] as string;
      expect(sql).toContain('has_tmp = $1');
    });

    it('applies min_properties filter', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({ min_properties: 5 });

      const sql = mockedQuery.mock.calls[0][0] as string;
      expect(sql).toContain('property_count >= $1');
    });

    it('caps limit at 200', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({ limit: 1000 });

      const params = mockedQuery.mock.calls[0][1] as unknown[];
      // Last param is limit+1 = 201
      expect(params[params.length - 1]).toBe(201);
    });

    it('defaults limit to 50', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({});

      const params = mockedQuery.mock.calls[0][1] as unknown[];
      expect(params[params.length - 1]).toBe(51);
    });

    it('computes relevance score with matched dimensions', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({ channels: ['ctv'], markets: ['US'], categories: ['IAB-7'] });

      const sql = mockedQuery.mock.calls[0][0] as string;
      // Score should include dimension contributions
      expect(sql).toContain('CASE WHEN channels &&');
      expect(sql).toContain('CASE WHEN markets &&');
      expect(sql).toContain('CASE WHEN categories &&');
      // Depth and TMP boost
      expect(sql).toContain('ln(property_count + 1)');
      expect(sql).toContain('has_tmp THEN 0.05');
    });

    it('detects has_more when result exceeds limit', async () => {
      const results = Array.from({ length: 4 }, (_, i) => ({
        agent_url: `https://agent${i}.example.com`,
        channels: ['ctv'],
        property_types: [],
        markets: [],
        categories: [],
        tags: [],
        delivery_types: [],
        format_ids: [],
        property_count: 10 - i,
        publisher_count: 1,
        has_tmp: true,
        category_taxonomy: null,
        relevance_score: 1 - i * 0.1,
        matched_filters: ['channels'],
        updated_at: new Date(),
      }));
      mockedQuery.mockResolvedValueOnce(mockResult(results)); // 4 rows for limit=3

      const response = await db.search({ channels: ['ctv'], limit: 3 });

      expect(response.results).toHaveLength(3);
      expect(response.has_more).toBe(true);
      expect(response.cursor).toBeTruthy();
    });

    it('returns empty with no cursor when no results', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      const response = await db.search({ channels: ['radio'] });

      expect(response.results).toHaveLength(0);
      expect(response.cursor).toBeNull();
      expect(response.has_more).toBe(false);
    });

    it('includes matched_filters in SQL', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({ channels: ['ctv'], markets: ['US'] });

      const sql = mockedQuery.mock.calls[0][0] as string;
      expect(sql).toContain('array_remove(');
      expect(sql).toContain("'channels'");
      expect(sql).toContain("'markets'");
    });

    it('returns all profiles when no filters specified', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([]));

      await db.search({});

      const sql = mockedQuery.mock.calls[0][0] as string;
      // No WHERE clause filters (only ORDER BY and LIMIT)
      expect(sql).not.toContain('&&');
      expect(sql).not.toContain('has_tmp =');
    });
  });

  // ── deleteStaleProfiles ─────────────────────────────────────────

  describe('deleteStaleProfiles', () => {
    it('deletes profiles not in the current list', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([], 3));

      const deleted = await db.deleteStaleProfiles(['https://keep.example.com']);

      expect(deleted).toBe(3);
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('!= ALL($1)'),
        [['https://keep.example.com']]
      );
    });

    it('deletes all profiles when empty list provided', async () => {
      mockedQuery.mockResolvedValueOnce(mockResult([], 5));

      const deleted = await db.deleteStaleProfiles([]);

      expect(deleted).toBe(5);
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM agent_inventory_profiles')
      );
    });
  });
});
