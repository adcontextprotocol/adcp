import { execFileSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';

function runTsxJson<T>(code: string): T {
  const markerStart = '__TEST_JSON_START__';
  const markerEnd = '__TEST_JSON_END__';
  const output = execFileSync(
    'node',
    ['--import', 'tsx', '--eval', code],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  const startIndex = output.lastIndexOf(markerStart);
  const endIndex = output.lastIndexOf(markerEnd);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing JSON marker in output:\n${output}`);
  }

  const json = output.slice(startIndex + markerStart.length, endIndex).trim();
  return JSON.parse(json) as T;
}

describe('TMP coverage in docs and training', () => {
  it('surfaces TMP and AdCP/OpenRTB docs in Addie search', () => {
    const urls = runTsxJson<string[]>(`
      import { initializeDocsIndex, searchDocs } from './server/src/addie/mcp/docs-indexer.ts';

      await initializeDocsIndex();
      const results = searchDocs('cross-publisher frequency capping TMP Trusted Match OpenRTB', { limit: 5 });
      console.log('__TEST_JSON_START__' + JSON.stringify(results.map((result) => result.sourceUrl)) + '__TEST_JSON_END__');
    `);

    expect(urls).toContain('https://docs.adcontextprotocol.org/docs/trusted-match');
    expect(urls).toContain('https://docs.adcontextprotocol.org/docs/building/understanding/adcp-vs-openrtb');
  });

  it('includes TMP in all relevant training modules', () => {
    const moduleResources = runTsxJson<Record<string, string[]>>(`
      import { MODULE_RESOURCES } from './server/src/addie/mcp/certification-tools.ts';

      console.log('__TEST_JSON_START__' + JSON.stringify({
        A3: MODULE_RESOURCES.A3.map((resource) => resource.url),
        B3: MODULE_RESOURCES.B3.map((resource) => resource.url),
        C1: MODULE_RESOURCES.C1.map((resource) => resource.url),
        D3: MODULE_RESOURCES.D3.map((resource) => resource.url),
        S1: MODULE_RESOURCES.S1.map((resource) => resource.url),
      }) + '__TEST_JSON_END__');
    `);

    const tmpUrl = 'https://docs.adcontextprotocol.org/docs/trusted-match';

    // Every module that touches execution should include TMP
    expect(moduleResources.A3).toContain(tmpUrl);
    expect(moduleResources.B3).toContain(tmpUrl);
    expect(moduleResources.C1).toContain(tmpUrl);
    expect(moduleResources.D3).toContain(tmpUrl);
    expect(moduleResources.S1).toContain(tmpUrl);

    // D3 should also have the specification and router architecture
    expect(moduleResources.D3).toEqual(expect.arrayContaining([
      'https://docs.adcontextprotocol.org/docs/trusted-match/specification',
      'https://docs.adcontextprotocol.org/docs/trusted-match/router-architecture',
    ]));

    // B3 and S1 should have context-and-identity deep dive
    expect(moduleResources.B3).toContain(
      'https://docs.adcontextprotocol.org/docs/trusted-match/context-and-identity'
    );
    expect(moduleResources.S1).toContain(
      'https://docs.adcontextprotocol.org/docs/trusted-match/context-and-identity'
    );
  });
});
