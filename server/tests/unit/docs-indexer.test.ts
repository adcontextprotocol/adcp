import { describe, it, expect, beforeAll, vi } from 'vitest';

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
  getDocsCorpusFingerprint,
  getSupportedDocsVersions,
  resolveDocsVersion,
  versionAliases,
  type DocsVersion,
} from '../../src/addie/mcp/docs-indexer.js';
import {
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from '../../src/addie/mcp/knowledge-search.js';
import { DOCS_SCHEMA_RELEASES } from '../../src/addie/mcp/schema-tools.js';
import { AddieDatabase } from '../../src/db/addie-db.js';

const STABLE_SNAPSHOT = DOCS_SCHEMA_RELEASES['3.1'];
const BETA_SNAPSHOT = DOCS_SCHEMA_RELEASES['3.2-beta'];

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

it('uses the newest same-line prerelease for the bare release selector', () => {
  const versions = [
    { version: '3.2-rc', artifactVersion: '3.2.0-rc.0', displayName: '3.2-rc' },
    { version: '3.2-beta', artifactVersion: '3.2.0-beta.12', displayName: '3.2-beta' },
  ].map((version) => ({
    ...version,
    isDefault: false,
    isArchived: false,
    pagePaths: new Set<string>(),
  })) satisfies DocsVersion[];

  expect(versionAliases(versions[0], versions)).toContain('3.2');
  expect(versionAliases(versions[0], versions)).toContain('3.2 rc');
  expect(versionAliases(versions[1], versions)).not.toContain('3.2');
  expect(versionAliases(versions[1], versions)).toContain('3.2 beta');
});

describe('docs-indexer', () => {
  beforeAll(async () => {
    await initializeDocsIndex();
  }, 30_000);

  it('initializes successfully with docs from the real docs directory', () => {
    expect(isDocsIndexReady()).toBe(true);
    expect(getDocCount()).toBeGreaterThan(0);
    expect(getDocsCorpusFingerprint()).toMatch(/^[0-9a-f]{64}$/);
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
    it('finds Addie\'s documented MCP interface from a natural-language capability question', () => {
      const results = searchDocs('does Addie exist as MCP', { limit: 5 });
      const connectionGuide = results.find((result) => result.id === 'doc:aao/connect-addie');

      expect(connectionGuide).toBeDefined();
      expect(connectionGuide?.content).toContain('chat_with_addie');
    });

    it('finds doc by canonical ID with prefix', () => {
      const doc = getDocById('doc:3.1:media-buy/advanced-topics/targeting');
      expect(doc).not.toBeNull();
      expect(doc!.title).toBe('Targeting');
      expect(doc!.version).toBe('3.1');
    });

    it('finds doc by bare path without prefix', () => {
      const doc = getDocById('media-buy/advanced-topics/targeting');
      expect(doc).not.toBeNull();
      expect(doc!.title).toBe('Targeting');
    });

    it('uses an explicit version for legacy unversioned IDs', () => {
      const doc = getDocById('media-buy/task-reference/get_products', { version: '3.2-beta' });
      expect(doc?.id).toBe('doc:3.2-beta:media-buy/task-reference/get_products');
      expect(doc?.sourceUrl).toContain(`/dist/docs/${BETA_SNAPSHOT}/`);
    });

    it('rejects a canonical versioned ID when the explicit version does not match', () => {
      expect(getDocById(
        'doc:3.2-beta:media-buy/task-reference/get_products',
        { version: '3.1' },
      )).toBeNull();
    });

    it('links version-independent live docs to their exact source file', () => {
      const doc = getDocById('aao/addie-tools');
      expect(doc?.sourceUrl).toBe(
        'https://github.com/adcontextprotocol/adcp/blob/main/docs/aao/addie-tools.mdx',
      );
    });
  });

  describe('protocol version isolation', () => {
    it('loads every public docs version and keeps 3.1 as stable default', () => {
      const versions = getSupportedDocsVersions();
      expect(versions.map(({ version }) => version)).toEqual(['3.1', '3.2-beta', '3.0', '2.5']);
      expect(resolveDocsVersion()?.version).toBe('3.1');
      expect(resolveDocsVersion('latest')?.version).toBe('3.1');
      expect(resolveDocsVersion('3.2')?.version).toBe('3.2-beta');
      expect(Object.fromEntries(
        versions.map(({ version, artifactVersion }) => [version, artifactVersion]),
      )).toEqual(DOCS_SCHEMA_RELEASES);
    });

    it('returns protocol results only from the requested version', () => {
      const snapshots = new Map(Object.entries(DOCS_SCHEMA_RELEASES));

      for (const [version, artifactVersion] of snapshots) {
        const results = searchDocs('protocol', { version, limit: 20 });
        const versionedResults = results.filter((doc) => doc.version);
        expect(versionedResults.length).toBeGreaterThan(0);
        expect(versionedResults.every((doc) => doc.version === version)).toBe(true);
        expect(versionedResults.every((doc) => doc.artifactVersion === artifactVersion)).toBe(true);
        expect(versionedResults.every((doc) => (
          doc.sourceUrl.startsWith(`https://docs.adcontextprotocol.org/dist/docs/${artifactVersion}/`)
          || doc.sourceUrl.startsWith(`https://adcontextprotocol.org/schemas/${artifactVersion}/`)
        ))).toBe(true);

        const intro = getDocById(`doc:${version}:intro`, { version });
        expect(intro?.artifactVersion).toBe(artifactVersion);
        expect(intro?.sourceUrl).toBe(
          `https://docs.adcontextprotocol.org/dist/docs/${artifactVersion}/intro`,
        );
      }
    });

    it('returns headings only from the requested protocol version', () => {
      const snapshots = new Map(Object.entries(DOCS_SCHEMA_RELEASES));

      for (const [version, artifactVersion] of snapshots) {
        const headings = searchHeadings('protocol', { version, limit: 20 });
        const versionedHeadings = headings.filter((heading) => /^doc:\d/.test(heading.doc_id));
        expect(versionedHeadings.length).toBeGreaterThan(0);
        expect(versionedHeadings.every((heading) => (
          heading.doc_id.startsWith(`doc:${version}:`) &&
          heading.sourceUrl.startsWith(
            `https://docs.adcontextprotocol.org/dist/docs/${artifactVersion}/`,
          )
        ))).toBe(true);
      }
    });

    it('does not leak the 3.2-only ACCOUNT_REQUIRED code into stable versions', () => {
      for (const version of ['3.1', '3.0', '2.5']) {
        const results = searchDocs('ACCOUNT_REQUIRED', { version, limit: 20 });
        expect(results.some((doc) => doc.content.includes('ACCOUNT_REQUIRED'))).toBe(false);
      }

      const betaResults = searchDocs('ACCOUNT_REQUIRED', { version: '3.2-beta', limit: 20 });
      expect(betaResults.map((doc) => doc.id)).toContain('schema:3.2-beta:enums/error-code');
      expect(betaResults.some((doc) => doc.content.includes('ACCOUNT_REQUIRED'))).toBe(true);
    });

    it('does not index 3.2-only pages from the polluted stable artifact', () => {
      const betaOnlyPaths = [
        'media-buy/task-reference/request_proposals',
        'reference/migration/cross-role-governance-enforcement',
        'reference/whats-new-in-3-2',
      ];
      for (const pagePath of betaOnlyPaths) {
        expect(getDocById(`doc:3.1:${pagePath}`, { version: '3.1' })).toBeNull();
        expect(getDocById(`doc:3.2-beta:${pagePath}`, { version: '3.2-beta' })).not.toBeNull();
      }
    });

    it('does not interpret natural-language error wording as a literal unavailable code', () => {
      expect(searchDocs('account required', { version: '3.1', limit: 20 }).length)
        .toBeGreaterThan(0);
    });

    it('exposes version selection and labels through Addie tools', async () => {
      const searchTool = KNOWLEDGE_TOOLS.find((tool) => tool.name === 'search_docs');
      const getDocTool = KNOWLEDGE_TOOLS.find((tool) => tool.name === 'get_doc');
      expect(searchTool?.input_schema.properties).toHaveProperty('version');
      expect(getDocTool?.input_schema.properties).toHaveProperty('version');
      expect(searchTool?.input_schema.properties.version).not.toHaveProperty('enum');
      expect(getDocTool?.input_schema.properties.version).not.toHaveProperty('enum');
      expect(searchTool?.input_schema.properties.limit).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 5,
      });

      const handlers = createKnowledgeToolHandlers();
      const search = handlers.get('search_docs');
      const getDoc = handlers.get('get_doc');
      expect(search).toBeDefined();
      expect(getDoc).toBeDefined();

      const stableResults = await search!({ query: 'ACCOUNT_REQUIRED', version: '3.1' });
      expect(stableResults).toContain(`No documentation found in AdCP 3.1 (snapshot ${STABLE_SNAPSHOT})`);

      const results = await search!({ query: 'ACCOUNT_REQUIRED', version: '3.2-beta' });
      expect(results).toContain(`Searching AdCP 3.2-beta (snapshot ${BETA_SNAPSHOT})`);
      expect(results).toContain(`**Version:** 3.2-beta (snapshot ${BETA_SNAPSHOT})`);
      expect(results).toContain('ACCOUNT_REQUIRED');

      const detail = await getDoc!({ doc_id: 'schema:3.2-beta:enums/error-code' });
      expect(detail).toContain(`**Version:** 3.2-beta (snapshot ${BETA_SNAPSHOT})`);
      expect(detail).toContain('ACCOUNT_REQUIRED');
    });

    it('clamps search_docs limits to integer results between one and five', async () => {
      const search = createKnowledgeToolHandlers().get('search_docs');
      expect(search).toBeDefined();

      expect(await search!({ query: 'protocol', limit: -10 })).toContain('Found 1 docs');
      expect(await search!({ query: 'protocol', limit: 2.9 })).toContain('Found 2 docs');
      expect(await search!({ query: 'protocol', limit: 100 })).toContain('Found 5 docs');
      expect(await search!({ query: 'protocol', limit: Number.NaN })).toContain('Found 3 docs');
    });

    it('can disable search telemetry for evaluation handlers without changing the default', async () => {
      const logSearch = vi.spyOn(AddieDatabase.prototype, 'logSearch').mockResolvedValue(undefined);
      try {
        const evaluationSearch = createKnowledgeToolHandlers({ disableSearchTelemetry: true }).get('search_docs');
        await evaluationSearch!({ query: 'protocol', limit: 1 });
        expect(logSearch).not.toHaveBeenCalled();

        const productionSearch = createKnowledgeToolHandlers().get('search_docs');
        await productionSearch!({ query: 'protocol', limit: 1 });
        expect(logSearch).toHaveBeenCalledOnce();
      } finally {
        logSearch.mockRestore();
      }
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

    it('finds the distinction between refinement and price-negotiation capability', () => {
      const results = searchDocs('price negotiation refinement capability', {
        limit: 20,
        version: '3.2-beta',
      });
      expect(results.map((doc) => doc.id)).toContain('doc:3.2-beta:media-buy/product-discovery/refinement');

      const refinement = getDocById('media-buy/product-discovery/refinement', { version: '3.2-beta' });
      expect(refinement?.content).toContain('There is no finer-grained price-negotiation capability flag.');
      expect(refinement?.content).toContain('omission communicates no per-ask outcome');
      expect(refinement?.content).toContain("Inspect the returned proposal's pricing and allocations");
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
        'schema:3.1:media-buy/get-products-request',
        'schema:3.1:core/product-filters',
      ].includes(doc.id))).toBe(true);

      const filters = getDocById('core/product-filters.json');
      expect(filters?.id).toBe('schema:3.1:core/product-filters');
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
      expect(results.map((doc) => doc.id)).toContain('doc:3.1:trusted-match/surfaces/ctv');
    });

    it('retrieves CTV enum and standard format registry sources', () => {
      const enumResults = searchDocs('ctv_app property type', { limit: 5 });
      expect(enumResults.map((doc) => doc.id)).toContain('schema:3.1:enums/property-type');

      const formatResults = searchDocs(
        'canonical creative format contracts publisher acceptance product deliverability',
        { limit: 5 },
      );
      expect(formatResults.map((doc) => doc.id)).toContain('doc:3.1:creative/formats');
    });
  });
});
