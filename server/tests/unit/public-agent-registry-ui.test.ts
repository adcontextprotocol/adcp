import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const agentsHtml = readFileSync(new URL('../../public/agents.html', import.meta.url), 'utf8');

describe('public agent registry UI', () => {
  it('uses the public discovery proxy routes instead of the removed MCP helpers', () => {
    expect(agentsHtml).toContain('/api/public/agent-products?url=');
    expect(agentsHtml).toContain('/api/public/agent-formats?url=');
    expect(agentsHtml).toContain('/v1/agents/${encodeURIComponent(spelling)}/publishers?status=authorized&status=revoked&limit=1000');
    expect(agentsHtml).not.toContain('/api/public/agent-publishers?url=');
    expect(agentsHtml).not.toContain("fetch(`/mcp`");
  });

  it('renders indexed publisher authorization records and handles non-JSON responses', () => {
    expect(agentsHtml).toContain('const raw = await response.text()');
    expect(agentsHtml).toContain('data = JSON.parse(raw)');
    expect(agentsHtml).toContain('p.publisher_domain');
    expect(agentsHtml).toContain('p.properties_authorized');
    expect(agentsHtml).toContain('response.status === 404');
    expect(agentsHtml).toContain('if (truncated)');
    expect(agentsHtml).toContain('Showing the first 1,000 publisher authorizations');
  });

  it('renders the complete discovered tool catalog count', () => {
    expect(agentsHtml).toContain('agent?.capabilities?.tools_count ?? agent?.health?.tools_count');
    expect(agentsHtml).toContain('agentWithCaps?.capabilities?.tools || []');
    expect(agentsHtml).toContain('&middot; ${agentToolCount(agentWithCaps)} tools');
    expect(agentsHtml).not.toContain('${coreImplemented.length + optionalImplemented.length} tools');
  });

  it('allowlists verification links and escapes responsive format dimensions', () => {
    expect(agentsHtml).toContain("parsed.protocol === 'https:'");
    expect(agentsHtml).not.toContain('href="${escapeHtml(p.verification_url)}"');
    expect(agentsHtml).toContain('escapeHtml(String(params.min_width || 0))');
  });

  // The registry lists an agent under its folded identity URL (#7830); the
  // directory matches spec-exactly (#7829, #8314). An agent whose publishers
  // declared it as `/mcp/` showed no publisher authorizations at all, because
  // the page only ever asked about the folded `/mcp`.
  describe('publisher records across declared spellings (#7830)', () => {
    const source = agentsHtml.match(
      /function declaredSpellings\(agent\) \{[\s\S]*?\n    \}\n\n    async function fetchPublisherRecords\(agent\) \{[\s\S]*?\n    \}\n/,
    )?.[0];
    const load = (fetchImpl: typeof fetch) =>
      new Function('fetch', `${source}; return fetchPublisherRecords;`)(fetchImpl) as (
        agent: { url: string; declared_urls?: string[] },
      ) => Promise<{ publishers: Array<{ publisher_domain: string; status: string }>; truncated: boolean }>;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    const CANONICAL = 'https://agent.example/mcp';
    const SLASHED = 'https://agent.example/mcp/';

    it('asks the directory about every declared spelling', async () => {
      expect(source).toBeDefined();
      const fetchMock = vi.fn(async (url: string) =>
        url.includes(encodeURIComponent(SLASHED))
          ? json(200, { publishers: [{ publisher_domain: 'slash.example', status: 'authorized' }], next_cursor: null })
          : json(404, { error: 'Agent has never been indexed by this directory' }));

      const result = await load(fetchMock as unknown as typeof fetch)({
        url: CANONICAL,
        declared_urls: [CANONICAL, SLASHED],
      });

      // Before the fix the page asked once, with the folded URL, and the
      // slash-declared agent rendered "no indexed publisher authorizations".
      expect(result.publishers.map(p => p.publisher_domain)).toEqual(['slash.example']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
        `/v1/agents/${encodeURIComponent(CANONICAL)}/publishers?status=authorized&status=revoked&limit=1000`,
        `/v1/agents/${encodeURIComponent(SLASHED)}/publishers?status=authorized&status=revoked&limit=1000`,
      ]);
    });

    it('merges spellings, preferring an authorized row over a revoked one', async () => {
      const fetchMock = vi.fn(async (url: string) =>
        url.includes(encodeURIComponent(SLASHED))
          ? json(200, { publishers: [{ publisher_domain: 'both.example', status: 'authorized' }], next_cursor: null })
          : json(200, {
              publishers: [
                { publisher_domain: 'both.example', status: 'revoked' },
                { publisher_domain: 'only-canonical.example', status: 'authorized' },
              ],
              next_cursor: 'abc',
            }));

      const result = await load(fetchMock as unknown as typeof fetch)({
        url: CANONICAL,
        declared_urls: [CANONICAL, SLASHED],
      });

      expect(result.publishers).toEqual([
        { publisher_domain: 'both.example', status: 'authorized' },
        { publisher_domain: 'only-canonical.example', status: 'authorized' },
      ]);
      // Truncation on any spelling truncates the merged view.
      expect(result.truncated).toBe(true);
    });

    it('falls back to the listed url when the listing carries no spellings', async () => {
      const fetchMock = vi.fn(async () => json(200, { publishers: [], next_cursor: null }));

      await load(fetchMock as unknown as typeof fetch)({ url: CANONICAL });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain(encodeURIComponent(CANONICAL));
    });

    it('surfaces a directory error rather than reporting an empty publisher set', async () => {
      const fetchMock = vi.fn(async () => json(503, { error: 'Directory unavailable' }));

      await expect(
        load(fetchMock as unknown as typeof fetch)({ url: CANONICAL, declared_urls: [CANONICAL, SLASHED] }),
      ).rejects.toThrow('Directory unavailable');
      expect(agentsHtml).toContain('error.directoryError');
    });
  });

  describe('registry list fetch', () => {
    const source = agentsHtml.match(/async function fetchRegistryAgents\(query\) \{[\s\S]*?\n    \}\n/)?.[0];
    const load = (fetchImpl: typeof fetch) =>
      new Function('fetch', `${source}; return fetchRegistryAgents;`)(fetchImpl) as (query: string) => Promise<unknown[]>;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    it('retries anonymously when a stale session cookie is rejected', async () => {
      expect(source).toBeDefined();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(401, { error: 'Invalid session', login_url: '/auth/login' }))
        .mockResolvedValueOnce(json(200, { agents: [{ url: 'https://agent.example' }], count: 1 }));

      await expect(load(fetchMock)('health=true')).resolves.toEqual([{ url: 'https://agent.example' }]);
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/registry/agents?health=true');
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/registry/agents?health=true', { credentials: 'omit' });
    });

    it('surfaces failures instead of rendering an empty registry', async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(503, { error: 'Authorization service temporarily unavailable' }));

      await expect(load(fetchMock)('health=true')).rejects.toThrow('Authorization service temporarily unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(agentsHtml).toContain('Failed to load agents: ${escapeHtml(loadError.message)}');
    });
  });
});
