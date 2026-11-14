/**
 * Origin-only `authorized_agents[].url` matching (#8943, DR-0023,
 * docs/governance/property/adagents#agent-url-matching).
 *
 * `agentUrlAuthorizedBy` is the one rule both `AgentValidator` and the
 * registry directory reads apply. This file checks the rule against the
 * shared fixture table and then checks the validator reaches the same verdict
 * on every row, so the two cannot disagree again (#7830). The registry side
 * of the same table runs against Postgres in
 * tests/integration/registry-directory-origin-only.test.ts.
 */
import dns from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentUrlAuthorizedBy,
  authorizationLookupKeys,
  canonicalAgentOrigin,
  isOriginOnlyAgentUrl,
  registryAgentUrlKey,
  registryAgentUrlLookupKey,
  specExactAgentUrl,
} from '../../src/db/registry-agent-url-key.js';
import { AgentValidator } from '../../src/validator.js';
import {
  AUTHORIZED_CASES,
  UNAUTHORIZED_CASES,
} from '../fixtures/authorized-agent-url-matching.js';

describe('agentUrlAuthorizedBy', () => {
  it.each(AUTHORIZED_CASES)('authorizes: $why ($entry → $agent)', ({ entry, agent }) => {
    expect(agentUrlAuthorizedBy(entry, agent)).toBe(true);
  });

  it.each(UNAUTHORIZED_CASES)('does not authorize: $why ($entry → $agent)', ({ entry, agent }) => {
    expect(agentUrlAuthorizedBy(entry, agent)).toBe(false);
  });

  it('treats the registry wildcard as an exact sentinel, never a URL', () => {
    expect(agentUrlAuthorizedBy('*', '*')).toBe(true);
    expect(agentUrlAuthorizedBy('*', 'https://agent.example.com/mcp')).toBe(false);
    expect(agentUrlAuthorizedBy('https://agent.example.com', '*')).toBe(false);
  });

  it('removes one trailing root dot and rejects more than one (spec step 2)', () => {
    expect(specExactAgentUrl('HTTPS://Agent.Example.COM.:443/mcp')).toBe('https://agent.example.com/mcp');
    expect(specExactAgentUrl('https://agent.example.com.:8443')).toBe('https://agent.example.com:8443/');
    expect(specExactAgentUrl('https://agent.example.com../mcp')).toBeNull();
    expect(agentUrlAuthorizedBy('https://agent.example.com..', 'https://agent.example.com/mcp')).toBe(false);
    // IPv6 literals are not DNS names; the root-dot rule does not touch them.
    expect(specExactAgentUrl('https://[2001:DB8::1]:8443/mcp')).toBe('https://[2001:db8::1]:8443/mcp');
  });

  it('rejects userinfo rather than stripping it, so a credential-bearing URL matches nothing', () => {
    expect(specExactAgentUrl('https://user:pw@agent.example.com/mcp')).toBeNull();
    expect(canonicalAgentOrigin('https://user@agent.example.com/mcp')).toBeNull();
    expect(agentUrlAuthorizedBy('https://agent.example.com', 'https://user@agent.example.com/mcp')).toBe(false);
  });

  it('matches nothing when either side cannot be canonicalized', () => {
    expect(agentUrlAuthorizedBy('not a url', 'https://agent.example.com/mcp')).toBe(false);
    expect(agentUrlAuthorizedBy('https://agent.example.com', 'not a url')).toBe(false);
    // Userinfo is rejected by the canonicalizer, never stripped into a match.
    expect(agentUrlAuthorizedBy('https://user:pw@agent.example.com', 'https://agent.example.com/mcp'))
      .toBe(false);
  });
});

describe('isOriginOnlyAgentUrl', () => {
  it.each([
    'https://agent.example.com',
    'https://agent.example.com/',
    'HTTPS://Agent.Example.COM:443/',
    'https://agent.example.com:8443',
    'https://agent.example.com/x/..',
    'https://agent.example.com#frag',
  ])('%s is origin-only', (url) => {
    expect(isOriginOnlyAgentUrl(url)).toBe(true);
  });

  it.each([
    'https://agent.example.com/mcp',
    'https://agent.example.com/mcp/',
    'https://agent.example.com//',
    'https://agent.example.com/?tenant=acme',
    'https://agent.example.com/?',
    'not a url',
  ])('%s is not origin-only', (url) => {
    expect(isOriginOnlyAgentUrl(url)).toBe(false);
  });
});

describe('canonicalAgentOrigin', () => {
  it('is scheme, lowercased host and non-default port only', () => {
    expect(canonicalAgentOrigin('HTTPS://Agent.Example.COM:443/mcp?x=1#f')).toBe('https://agent.example.com');
    expect(canonicalAgentOrigin('https://agent.example.com:8443/mcp')).toBe('https://agent.example.com:8443');
    expect(canonicalAgentOrigin('http://agent.example.com:80/')).toBe('http://agent.example.com');
    expect(canonicalAgentOrigin('https://[2001:DB8::1]:8443/mcp')).toBe('https://[2001:db8::1]:8443');
    expect(canonicalAgentOrigin('not a url')).toBeNull();
  });

  it('drops a single trailing root dot, as the spec canonical origin does', () => {
    expect(canonicalAgentOrigin('https://agent.example.com./mcp')).toBe('https://agent.example.com');
    expect(canonicalAgentOrigin('https://agent.example.com.:8443/')).toBe('https://agent.example.com:8443');
  });
});

describe('authorizationLookupKeys', () => {
  it("is the agent's own key plus the key an origin-only entry for its origin is stored under", () => {
    expect(authorizationLookupKeys('https://agent.example.com/mcp'))
      .toEqual(['https://agent.example.com/mcp', 'https://agent.example.com']);
    // The origin-only entry spellings all key to the second lookup key.
    for (const entry of ['https://agent.example.com', 'https://agent.example.com/', 'HTTPS://Agent.Example.COM:443']) {
      expect(registryAgentUrlKey(entry)).toBe('https://agent.example.com');
    }
  });

  it('is one key when the agent is at the origin itself', () => {
    expect(authorizationLookupKeys('https://agent.example.com/')).toEqual(['https://agent.example.com']);
  });

  it('keeps a non-default port in the origin key', () => {
    expect(authorizationLookupKeys('https://agent.example.com:8443/mcp'))
      .toEqual(['https://agent.example.com:8443/mcp', 'https://agent.example.com:8443']);
  });

  it('adds the key of the canonical form for a spelling the registry cannot key raw', () => {
    // The validator canonicalizes `https:agent.example.com/mcp` to
    // `https://agent.example.com/mcp` and matches an entry for it; the
    // directory must look that entry's key up too.
    expect(registryAgentUrlKey('https:agent.example.com/mcp')).toBeNull();
    expect(authorizationLookupKeys('https:agent.example.com/mcp')).toEqual([
      'https:agent.example.com/mcp',
      'https://agent.example.com/mcp',
      'https://agent.example.com',
    ]);
  });

  it('falls back to the raw lookup key alone for an input that cannot be canonicalized', () => {
    expect(authorizationLookupKeys('agent.example.com/mcp'))
      .toEqual([registryAgentUrlLookupKey('agent.example.com/mcp')]);
  });

  it('covers every authorizing entry in the fixture table', () => {
    // The registry reads rows by these keys, then filters with
    // agentUrlAuthorizedBy. If an authorizing entry were stored under a key
    // outside this set, the registry would miss an authorization the
    // validator grants.
    for (const { entry, agent } of AUTHORIZED_CASES) {
      expect(authorizationLookupKeys(agent)).toContain(registryAgentUrlKey(entry));
    }
  });
});

describe('AgentValidator agrees with agentUrlAuthorizedBy on the shared fixtures', () => {
  let validator: AgentValidator;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    validator = new AgentValidator();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '203.0.113.5', family: 4 },
    ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function manifestFor(url: string) {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ authorized_agents: [{ url, authorized_for: 'Direct' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
  }

  it.each([...AUTHORIZED_CASES, ...UNAUTHORIZED_CASES])(
    'same verdict: $why ($entry → $agent)',
    async ({ entry, agent }) => {
      manifestFor(entry);
      const result = await validator.validate('example.com', agent);
      expect(result.authorized).toBe(agentUrlAuthorizedBy(entry, agent));
    },
  );
});
