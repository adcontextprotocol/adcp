import { describe, it, expect, beforeAll, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    async getIndexedDocumentsWithContent() { return []; }
  },
}));

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

// Import the actual indexer functions
import {
  cleanContent,
  extractSchemaContent,
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

  describe('schema and MDX retrieval (#5861)', () => {
    it('preserves Mintlify component children while removing JSX tags', () => {
      const cleaned = cleanContent(`---
title: Targeting
---
<Accordion title="Structured filters">
The request includes a structured \`filters\` object.
<ParamField path="filters.channels">Includes ctv.</ParamField>
</Accordion>`);

      expect(cleaned).toContain('The request includes a structured `filters` object.');
      expect(cleaned).toContain('Includes ctv.');
      expect(cleaned).not.toContain('<Accordion');
      expect(cleaned).not.toContain('<ParamField');
    });

    it('extracts searchable schema facts without structural validation noise', () => {
      const content = extractSchemaContent({
        $id: '/schemas/example.json',
        description: 'Example request.',
        type: 'object',
        properties: {
          channel: {
            description: 'Requested channel.',
            enum: ['display', 'ctv'],
          },
          filters: { $ref: '/schemas/core/product-filters.json' },
        },
        required: ['channel'],
        additionalProperties: false,
      });

      expect(content).toContain('Field: channel');
      expect(content).toContain('channel allowed values: "display", "ctv"');
      expect(content).toContain('filters references /schemas/core/product-filters.json');
      expect(content).toContain('Schema required fields: "channel"');
      expect(content).not.toContain('additionalProperties');
    });

    it('indexes get_products and product filter schema facts', () => {
      const results = searchDocs('get_products filters geo', { limit: 5 });
      expect(results.some((doc) => [
        'schema:media-buy/get-products-request',
        'schema:core/product-filters',
      ].includes(doc.id))).toBe(true);

      const filters = getDocById('core/product-filters.json');
      expect(filters?.id).toBe('schema:core/product-filters');
      expect(filters?.content).toContain('Field: countries');
      expect(filters?.content).toContain('Field: channels');
    });

    it('excludes duplicate aggregate schemas', () => {
      expect(getDocById('schema:index')).toBeNull();
      expect(getDocById('schema:brand')).toBeNull();
      expect(getDocById('schema:protocol/get-adcp-capabilities-response')).toBeNull();
    });

    it('ranks the Trusted Match CTV surface guide for a channel query', () => {
      const results = searchDocs('trusted match ctv', { limit: 3 });
      expect(results.map((doc) => doc.id)).toContain('doc:trusted-match/surfaces/ctv');
    });

    it('retrieves CTV enum and standard format registry sources', () => {
      const enumResults = searchDocs('ctv_app property type', { limit: 5 });
      expect(enumResults.map((doc) => doc.id)).toContain('schema:enums/property-type');

      const formatResults = searchDocs(
        'standard format registry creative.adcontextprotocol.org',
        { limit: 5 },
      );
      expect(formatResults.map((doc) => doc.id)).toContain('doc:creative/formats');
    });
  });
});
