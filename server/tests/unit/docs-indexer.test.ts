import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Import the actual indexer functions
import {
  initializeDocsIndex,
  searchDocs,
  searchHeadings,
  isDocsIndexReady,
  getDocCount,
  getHeadingCount,
  getDocById,
} from '../../src/addie/mcp/docs-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Docs Indexer Tests
 *
 * Verifies that the in-memory search index correctly indexes and
 * retrieves AdCP documentation content. Tests run against the real
 * docs/ directory to catch regressions where content exists but
 * search fails to find it.
 *
 * Regression: Escalation #174 — searches for targeting_overlay and
 * geo_proximity returned no results despite the content existing in
 * docs/media-buy/advanced-topics/targeting.mdx.
 */

describe('docs-indexer', () => {
  beforeAll(async () => {
    await initializeDocsIndex();
  });

  it('initializes successfully with docs from the real docs directory', () => {
    expect(isDocsIndexReady()).toBe(true);
    expect(getDocCount()).toBeGreaterThan(0);
  });

  it('indexes heading-level content', () => {
    expect(getHeadingCount()).toBeGreaterThan(0);
  });

  describe('v3 targeting content (escalation #174)', () => {
    it('finds targeting_overlay in doc-level search', () => {
      const results = searchDocs('targeting_overlay');
      expect(results.length).toBeGreaterThan(0);

      const hasTargetingDoc = results.some(
        (r) => r.id.includes('targeting')
      );
      expect(hasTargetingDoc).toBe(true);
    });

    it('finds geo_proximity in doc-level search', () => {
      const results = searchDocs('geo_proximity');
      expect(results.length).toBeGreaterThan(0);

      const hasTargetingDoc = results.some(
        (r) => r.id.includes('targeting')
      );
      expect(hasTargetingDoc).toBe(true);
    });

    it('finds targeting_overlay in heading-level search', () => {
      const results = searchHeadings('targeting_overlay');
      expect(results.length).toBeGreaterThan(0);
    });

    it('finds geo_proximity in heading-level search', () => {
      const results = searchHeadings('geo_proximity');
      expect(results.length).toBeGreaterThan(0);
    });

    it('finds geo_proximity as a named section', () => {
      const results = searchHeadings('geo_proximity');
      const geoSection = results.find(
        (h) => h.title.toLowerCase().includes('geo_proximity')
      );
      expect(geoSection).toBeDefined();
    });
  });

  describe('get_doc ID resolution', () => {
    it('finds doc by canonical ID with prefix', () => {
      const doc = getDocById('doc:media-buy/advanced-topics/targeting');
      expect(doc).not.toBeNull();
      expect(doc!.title).toBe('Targeting');
    });

    it('finds doc by bare path without prefix', () => {
      const doc = getDocById('media-buy/advanced-topics/targeting');
      expect(doc).not.toBeNull();
      expect(doc!.title).toBe('Targeting');
    });
  });

  describe('basic search functionality', () => {
    it('returns results for common protocol terms', () => {
      expect(searchDocs('media buy').length).toBeGreaterThan(0);
      expect(searchDocs('creative').length).toBeGreaterThan(0);
      expect(searchDocs('targeting').length).toBeGreaterThan(0);
    });

    it('respects limit parameter', () => {
      const results = searchDocs('protocol', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for nonsense queries', () => {
      const results = searchDocs('xyzzy_nonexistent_term_12345');
      expect(results.length).toBe(0);
    });
  });
});
