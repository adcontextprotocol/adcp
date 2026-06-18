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
});
