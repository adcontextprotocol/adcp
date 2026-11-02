/**
 * The registry key folds a trailing slash; authorization matching does not.
 *
 * #7830 made `/mcp` and `/mcp/` one agent for registry IDENTITY, because
 * they are one endpoint in practice and every key collision in production
 * was that pair. #7829 made authorization matching spec-exact, where a
 * trailing slash is significant. Both are true at once, and the seam between
 * them is `declaredAgentUrl`: identity reads the key, authorization reads the
 * URL as registered.
 *
 * If this file ever goes green with `validate()` taking `agent.url`, a
 * publisher that authorized `/mcp` will have been made to authorize `/mcp/`
 * as well — a silent widening of every adagents.json in the registry.
 */
import dns from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/member-db.js', () => ({
  MemberDatabase: class {
    async listProfiles() { return listProfilesMock(); }
  },
}));

const listProfilesMock = vi.fn();

import { AgentService } from '../../src/agent-service.js';
import { AgentValidator } from '../../src/validator.js';
import { declaredAgentUrl, registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';
import { gateAgentVisibilityForCaller } from '../../src/services/agent-visibility-gate.js';

const MANIFEST_WITH_TRAILING_SLASH = {
  authorized_agents: [{ url: 'https://a.example/mcp/', authorized_for: 'everything' }],
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function profileWith(agent: Record<string, unknown>) {
  return [{
    id: 'profile-1',
    slug: 'member',
    display_name: 'Member',
    description: '',
    contact_email: '',
    contact_website: '',
    created_at: new Date('2026-01-01T00:00:00Z'),
    agents: [agent],
  }];
}

describe('registry identity folds a trailing slash; authorization does not', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listProfilesMock.mockReset();
    fetchMock = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse(MANIFEST_WITH_TRAILING_SLASH));
    vi.stubGlobal('fetch', fetchMock);
    // The validator resolves hosts as an SSRF guard; these are fixtures.
    vi.spyOn(dns, 'lookup').mockResolvedValue(
      [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keys /mcp and /mcp/ as one agent', () => {
    expect(registryAgentUrlKey('https://a.example/mcp/'))
      .toBe(registryAgentUrlKey('https://a.example/mcp'));
    expect(registryAgentUrlKey('https://a.example/mcp/')).toBe('https://a.example/mcp');
  });

  it('still treats /mcp and /mcp/ as different agents for authorization', async () => {
    const validator = new AgentValidator();

    // The publisher declared the trailing-slash form.
    await expect(validator.validate('pub.example', 'https://a.example/mcp/'))
      .resolves.toMatchObject({ authorized: true });
    // The folded identity key is NOT authorized by that entry.
    await expect(validator.validate('pub.example', 'https://a.example/mcp'))
      .resolves.toMatchObject({ authorized: false });
  });

  it('hands the registered spelling, not the key, to authorization matching', async () => {
    listProfilesMock.mockResolvedValue(profileWith({
      url: 'https://a.example/mcp',
      declared_url: 'https://a.example/mcp/',
      visibility: 'public',
      type: 'sales',
    }));

    const [agent] = await new AgentService().listAgents('sales');

    // Identity is the folded key; the endpoint to call and to match on is
    // the one that was registered.
    expect(agent.url).toBe('https://a.example/mcp');
    expect(declaredAgentUrl(agent)).toBe('https://a.example/mcp/');
    expect(agent.mcp_endpoint).toBe('https://a.example/mcp/');

    const validator = new AgentValidator();

    // This is what find_agents_for_property does. Using agent.url here
    // would return authorized:false and silently drop the agent.
    await expect(validator.validate('pub.example', declaredAgentUrl(agent)))
      .resolves.toMatchObject({ authorized: true });
  });

  it('refuses a declared_url that is not just another spelling of the key', async () => {
    // Without this, a member could claim their own agent's identity and
    // another agent's declared URL, and the directory would report theirs
    // as authorized wherever that one is.
    const { agents } = gateAgentVisibilityForCaller([{
      url: 'https://evil.example/mcp',
      declared_url: 'https://legit.example/mcp',
      visibility: 'public',
      type: 'sales',
    }], true);

    expect(agents[0].url).toBe('https://evil.example/mcp');
    expect(agents[0].declared_url).toBeUndefined();
    expect(declaredAgentUrl(agents[0])).toBe('https://evil.example/mcp');
  });

  it('keeps a declared_url that keys back to the same agent', () => {
    const { agents } = gateAgentVisibilityForCaller([{
      url: 'https://a.example/mcp',
      declared_url: 'https://a.example/mcp/',
      visibility: 'public',
      type: 'sales',
    }], true);

    expect(agents[0].declared_url).toBe('https://a.example/mcp/');
  });

  it('falls back to the key when nothing was folded', async () => {
    listProfilesMock.mockResolvedValue(profileWith({
      url: 'https://b.example/mcp',
      visibility: 'public',
      type: 'sales',
    }));

    const [agent] = await new AgentService().listAgents('sales');

    expect(agent.declared_url).toBeUndefined();
    expect(declaredAgentUrl(agent)).toBe('https://b.example/mcp');
    expect(agent.mcp_endpoint).toBe('https://b.example/mcp');
  });
});
