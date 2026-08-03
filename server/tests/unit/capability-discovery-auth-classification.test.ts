import { describe, expect, it, vi } from 'vitest';

class MockAuthenticationRequiredError extends Error {
  hasOAuth = false;

  constructor(url: string, _metadata?: unknown, message = 'Agent requires authentication') {
    super(message);
    this.name = 'AuthenticationRequiredError';
    this.hasOAuth = url.includes('oauth');
  }
}

const getAgentInfoMock = vi.fn();

vi.mock('@adcp/sdk', () => ({
  AuthenticationRequiredError: MockAuthenticationRequiredError,
  is401Error: (error: unknown) => (error as { status?: number })?.status === 401,
  AdCPClient: class {
    agent() {
      return {
        getAgentInfo: getAgentInfoMock,
      };
    }
  },
}));

vi.mock('../../src/db/outbound-log-db.js', () => ({
  logOutboundRequest: vi.fn(),
}));

const { CapabilityDiscovery } = await import('../../src/capabilities.js');

const AGENT = {
  name: 'Auth Test Agent',
  url: 'https://agent.example.com/mcp',
  type: 'sales' as const,
  protocol: 'mcp' as const,
  description: '',
  mcp_endpoint: 'https://agent.example.com/mcp',
  contact: { name: '', email: '', website: '' },
  added_date: '2026-06-18',
};

describe('CapabilityDiscovery auth classification', () => {
  it('marks unauthenticated generic 401 discovery as oauth_required', async () => {
    getAgentInfoMock.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));

    const profile = await new CapabilityDiscovery().discoverCapabilities(AGENT);

    expect(profile.discovered_tools).toEqual([]);
    expect(profile.discovery_error).toBe('Agent requires authentication');
    expect(profile.oauth_required).toBe(true);
  });

  it('does not relabel rejected saved bearer auth as oauth_required', async () => {
    getAgentInfoMock.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));

    const profile = await new CapabilityDiscovery().discoverCapabilities(AGENT, {
      type: 'bearer',
      token: 'saved-but-rejected',
    });

    expect(profile.discovered_tools).toEqual([]);
    expect(profile.discovery_error).toBe('Unauthorized');
    expect(profile.oauth_required).toBe(false);
  });

  it('serves a cached unauthed profile within the TTL by default', async () => {
    getAgentInfoMock.mockResolvedValueOnce({ tools: [{ name: 'list_creative_formats' }] });

    const discovery = new CapabilityDiscovery();
    const first = await discovery.discoverCapabilities(AGENT);
    expect(first.discovered_tools).toHaveLength(1);

    const callsAfterFirst = getAgentInfoMock.mock.calls.length;

    // Second call should hit the cache — getAgentInfo must not be called again.
    const second = await discovery.discoverCapabilities(AGENT);
    expect(getAgentInfoMock.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toBe(first);
  });

  it('bypasses the unauthed cache when forceRefresh is set (manual "Recheck Status")', async () => {
    getAgentInfoMock.mockResolvedValueOnce({ tools: [{ name: 'list_creative_formats' }] });

    const discovery = new CapabilityDiscovery();
    await discovery.discoverCapabilities(AGENT);
    const callsAfterFirst = getAgentInfoMock.mock.calls.length;

    getAgentInfoMock.mockResolvedValueOnce({ tools: [] });
    const refreshed = await discovery.discoverCapabilities(AGENT, undefined, true);

    expect(getAgentInfoMock.mock.calls.length).toBe(callsAfterFirst + 1);
    expect(refreshed.discovered_tools).toEqual([]);
  });
});
