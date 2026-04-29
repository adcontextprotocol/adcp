import { describe, expect, it, beforeAll } from 'vitest';
import { initializeDocsIndex, searchDocs } from '../../server/src/addie/mcp/docs-indexer.js';
import { MODULE_RESOURCES } from '../../server/src/addie/mcp/certification-tools.js';

describe('TMP coverage in docs and training', () => {
  beforeAll(async () => {
    await initializeDocsIndex();
  });

  it('surfaces TMP and AdCP/OpenRTB docs in Addie search', () => {
    const results = searchDocs('cross-publisher frequency capping TMP Trusted Match OpenRTB', { limit: 5 });
    const urls = results.map((result) => result.sourceUrl);

    expect(urls).toContain('https://docs.adcontextprotocol.org/docs/trusted-match');
    expect(urls).toContain('https://docs.adcontextprotocol.org/docs/building/understanding/adcp-vs-openrtb');
  });

  it('includes TMP in all relevant training modules', () => {
    const tmpUrl = 'https://docs.adcontextprotocol.org/docs/trusted-match';

    expect(MODULE_RESOURCES.A3.map((r) => r.url)).toContain(tmpUrl);
    expect(MODULE_RESOURCES.B3.map((r) => r.url)).toContain(tmpUrl);
    expect(MODULE_RESOURCES.C1.map((r) => r.url)).toContain(tmpUrl);
    expect(MODULE_RESOURCES.D3.map((r) => r.url)).toContain(tmpUrl);
    expect(MODULE_RESOURCES.S1.map((r) => r.url)).toContain(tmpUrl);

    expect(MODULE_RESOURCES.D3.map((r) => r.url)).toEqual(expect.arrayContaining([
      'https://docs.adcontextprotocol.org/docs/trusted-match/specification',
      'https://docs.adcontextprotocol.org/docs/trusted-match/router-architecture',
    ]));

    expect(MODULE_RESOURCES.B3.map((r) => r.url)).toContain(
      'https://docs.adcontextprotocol.org/docs/trusted-match/context-and-identity'
    );
    expect(MODULE_RESOURCES.S1.map((r) => r.url)).toContain(
      'https://docs.adcontextprotocol.org/docs/trusted-match/context-and-identity'
    );
  });
});
