import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockAuthenticationRequiredError extends Error {
  hasOAuth = false;

  constructor(url: string, _metadata?: unknown, message = 'Agent requires authentication') {
    super(message);
    this.name = 'AuthenticationRequiredError';
    this.hasOAuth = url.includes('oauth');
  }
}

const getAgentInfoMock = vi.fn();
const getAdcpCapabilitiesMock = vi.fn();

vi.mock('@adcp/sdk', () => ({
  AuthenticationRequiredError: MockAuthenticationRequiredError,
  is401Error: (error: unknown) => (error as { status?: number })?.status === 401,
  AdCPClient: class {
    agent() {
      return {
        getAgentInfo: getAgentInfoMock,
        getAdcpCapabilities: getAdcpCapabilitiesMock,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('CapabilityDiscovery queued authorization checkpoints', () => {
  const auth = { type: 'bearer' as const, token: 'saved-test-token' };
  const revoked = Object.assign(new Error('Access changed during the refresh'), { code: 'authorization_revoked' });
  const tools = [{ name: 'get_adcp_capabilities' }, { name: 'build_creative' }];

  beforeEach(() => {
    getAgentInfoMock.mockReset();
    getAdcpCapabilitiesMock.mockReset();
  });

  it.each(['mcp', 'a2a'] as const)('does not start a capability call after revocation during %s discovery', async (protocol) => {
    let authorized = true;
    const checkpoint = async () => { if (!authorized) throw revoked; };
    const entered = deferred<void>();
    const discovery = deferred<{ tools: typeof tools }>();
    getAgentInfoMock.mockImplementation(() => { entered.resolve(); return discovery.promise; });

    const operation = new CapabilityDiscovery().discoverCapabilities({ ...AGENT, protocol }, auth, true, checkpoint);
    const rejected = expect(operation).rejects.toBe(revoked);
    await entered.promise;
    authorized = false;
    discovery.resolve({ tools });

    await rejected;
    expect(getAgentInfoMock).toHaveBeenCalledOnce();
    expect(getAdcpCapabilitiesMock).not.toHaveBeenCalled();
  });

  it('preserves revocation after a pending capability response instead of using the creative fallback', async () => {
    let authorized = true;
    const checkpoint = async () => { if (!authorized) throw revoked; };
    const entered = deferred<void>();
    const capabilities = deferred<{ success: boolean }>();
    getAgentInfoMock.mockResolvedValue({ tools });
    getAdcpCapabilitiesMock.mockImplementation(() => { entered.resolve(); return capabilities.promise; });

    const operation = new CapabilityDiscovery().discoverCapabilities(AGENT, auth, true, checkpoint);
    const rejected = expect(operation).rejects.toBe(revoked);
    await entered.promise;
    authorized = false;
    capabilities.resolve({ success: false });

    await rejected;
    expect(getAdcpCapabilitiesMock).toHaveBeenCalledOnce();
  });

  it('checks authorization again before creative fallback when the first capability call rejects', async () => {
    let authorized = true;
    const unavailable = Object.assign(new Error('Authorization unavailable'), { code: 'authorization_unavailable' });
    const checkpoint = async () => { if (!authorized) throw unavailable; };
    const entered = deferred<void>();
    const capabilities = deferred<never>();
    getAgentInfoMock.mockResolvedValue({ tools });
    getAdcpCapabilitiesMock.mockImplementation(() => { entered.resolve(); return capabilities.promise; });

    const operation = new CapabilityDiscovery().discoverCapabilities(AGENT, auth, true, checkpoint);
    const rejected = expect(operation).rejects.toBe(unavailable);
    await entered.promise;
    authorized = false;
    capabilities.reject(new Error('Capability endpoint failed'));

    await rejected;
    expect(getAdcpCapabilitiesMock).toHaveBeenCalledOnce();
  });

  it.each(['authorization_unavailable', 'authorization_provenance_missing', 'lease_lost'])(
    'preserves %s before the first authenticated call', async (code) => {
      const failure = Object.assign(new Error('Refresh access failed'), { code });
      await expect(new CapabilityDiscovery().discoverCapabilities(AGENT, auth, true, async () => { throw failure; }))
        .rejects.toBe(failure);
      expect(getAgentInfoMock).not.toHaveBeenCalled();
      expect(getAdcpCapabilitiesMock).not.toHaveBeenCalled();
    },
  );
});
