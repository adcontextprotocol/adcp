/**
 * One fixture table for adagents.json agent URL matching (#8943, DR-0023,
 * docs/governance/property/adagents#agent-url-matching).
 *
 * Shared by the `agentUrlAuthorizedBy` unit test, the `AgentValidator` unit
 * test and the registry directory integration test, so the validator and the
 * registry are checked against exactly the same cases and cannot drift apart
 * again (#7830).
 *
 * `entry` is the publisher's `authorized_agents[].url`; `agent` is the URL
 * the agent is reached at.
 */
export interface AgentUrlMatchCase {
  entry: string;
  agent: string;
  why: string;
}

/** Cases where the entry MUST authorize the agent. */
export const AUTHORIZED_CASES: readonly AgentUrlMatchCase[] = [
  // Origin-only entry, agent at a deeper path.
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com/mcp', why: 'origin-only entry, agent at a path' },
  { entry: 'https://agent.example.com/', agent: 'https://agent.example.com/mcp', why: 'origin-only entry with root slash, agent at a path' },
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com/a2a/v1', why: 'origin-only entry, agent at a nested path' },
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com/mcp/', why: 'origin-only entry, agent path with trailing slash' },
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com/mcp?tenant=acme', why: 'origin-only entry, agent URL with a query' },
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com', why: 'origin-only entry, agent at the origin' },
  // Trailing-slash normalization of the root path.
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com/', why: 'root trailing slash does not matter' },
  { entry: 'https://agent.example.com/', agent: 'https://agent.example.com', why: 'root trailing slash does not matter (reverse)' },
  // Default-port and case normalization of the origin.
  { entry: 'https://agent.example.com:443', agent: 'https://agent.example.com/mcp', why: 'default https port on the entry is dropped' },
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com:443/mcp', why: 'default https port on the agent is dropped' },
  { entry: 'http://agent.example.com:80/', agent: 'http://agent.example.com/mcp', why: 'default http port is dropped' },
  { entry: 'https://agent.example.com:8443', agent: 'https://agent.example.com:8443/mcp', why: 'same non-default port' },
  { entry: 'HTTPS://Agent.Example.COM', agent: 'https://agent.example.com/mcp', why: 'scheme and host case do not matter' },
  { entry: 'https://agent.example.com/x/..', agent: 'https://agent.example.com/mcp', why: 'dot segments resolving to the root are origin-only' },
  { entry: 'https://agent.example.com#frag', agent: 'https://agent.example.com/mcp', why: 'fragment is ignored' },
  // A single trailing root-label dot on the host is removed (spec step 2).
  { entry: 'https://agent.example.com.', agent: 'https://agent.example.com/mcp', why: 'trailing root dot on an origin-only entry' },
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com./mcp', why: 'trailing root dot on the agent host' },
  { entry: 'https://agent.example.com.:8443/mcp', agent: 'https://agent.example.com:8443/mcp', why: 'trailing root dot before a port' },
  // An agent URL the registry cannot key raw, but the canonicalizer accepts.
  { entry: 'https://agent.example.com/mcp', agent: 'https:agent.example.com/mcp', why: 'agent URL without // after the scheme' },
  { entry: 'https://agent.example.com/mcp', agent: 'https://agent.example.com\\mcp', why: 'agent URL with a backslash for a slash' },
  // An entry with a path still matches its canonical URL.
  { entry: 'https://agent.example.com/mcp', agent: 'https://agent.example.com/mcp', why: 'path entry, same URL' },
  { entry: 'https://agent.example.com/mcp', agent: 'HTTPS://Agent.Example.COM:443/mcp', why: 'path entry, canonically equal URL' },
  { entry: 'https://agent.example.com/~mcp', agent: 'https://agent.example.com/%7Emcp', why: 'path entry, unreserved percent-encoding decoded' },
];

/** Cases where the entry MUST NOT authorize the agent. */
export const UNAUTHORIZED_CASES: readonly AgentUrlMatchCase[] = [
  // Origin-only entry, agent at a different origin.
  { entry: 'https://agent.example.com', agent: 'https://other.example.com/mcp', why: 'origin-only entry, different host' },
  { entry: 'https://agent.example.com', agent: 'https://sub.agent.example.com/mcp', why: 'origin-only entry, subdomain is a different origin' },
  { entry: 'https://agent.example.com', agent: 'http://agent.example.com/mcp', why: 'origin-only entry, different scheme' },
  { entry: 'https://agent.example.com', agent: 'https://agent.example.com:8443/mcp', why: 'origin-only entry, different port' },
  { entry: 'https://agent.example.com:8443', agent: 'https://agent.example.com/mcp', why: 'non-default port entry, default-port agent' },
  // Path entry, different path.
  { entry: 'https://agent.example.com/mcp', agent: 'https://agent.example.com/a2a', why: 'path entry, different path' },
  { entry: 'https://platform.example/tenants/acme/mcp', agent: 'https://platform.example/tenants/zenith/mcp', why: 'path entry, another tenant on the same host' },
  { entry: 'https://agent.example.com/mcp', agent: 'https://agent.example.com/mcp/', why: 'path entry, non-root trailing slash is significant' },
  { entry: 'https://agent.example.com/mcp/', agent: 'https://agent.example.com/mcp', why: 'path entry with trailing slash, slashless agent' },
  { entry: 'https://agent.example.com/mcp', agent: 'https://agent.example.com/MCP', why: 'path entry, path case is significant' },
  { entry: 'https://agent.example.com/mcp', agent: 'https://agent.example.com/mcp/v2', why: 'path entry does not cover deeper paths' },
  // Directional: a path entry never authorizes the bare origin.
  { entry: 'https://agent.example.com/mcp', agent: 'https://agent.example.com', why: 'path entry, agent at the origin' },
  // A query makes an entry not origin-only.
  { entry: 'https://agent.example.com/?tenant=acme', agent: 'https://agent.example.com/mcp', why: 'root path with a query is not origin-only' },
  { entry: 'https://agent.example.com/?', agent: 'https://agent.example.com/mcp', why: 'root path with an empty query is not origin-only' },
];

/**
 * `signing_keys` when more than one entry matches one agent (#9016,
 * docs/governance/property/adagents#agent-url-matching): the agent is pinned
 * only if every matching entry pins (an absent or empty `signing_keys` is
 * unpinned), and then it may sign with the union of their keys.
 *
 * Each key is identified by its `kid`; `expectedKids` is the union in
 * document order, or `null` for unpinned (no restriction). Shared by the
 * combination unit test, the `AgentValidator` unit test and the registry
 * directory integration test (`signing_keys_pinned` is `expectedKids !==
 * null`).
 */
export interface SigningKeyEntry {
  url: string;
  /** `kid`s of the keys this entry pins; omitted for no `signing_keys`. */
  kids?: string[];
  /** An `effective_until` for the entry; a past one means it authorizes nothing. */
  effectiveUntil?: string;
}

export interface SigningKeyMatchCase {
  why: string;
  agent: string;
  entries: readonly SigningKeyEntry[];
  expectedKids: string[] | null;
}

const SK_ORIGIN = 'https://signer.example.com';
const SK_AGENT = 'https://signer.example.com/mcp';

export const SIGNING_KEY_CASES: readonly SigningKeyMatchCase[] = [
  // The issue's example, in both entry orders.
  {
    why: 'origin unpinned, /mcp pinned: unpinned for /mcp',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN }, { url: SK_AGENT, kids: ['k1'] }],
    expectedKids: null,
  },
  {
    why: '/mcp pinned, origin unpinned (reverse order): unpinned for /mcp',
    agent: SK_AGENT,
    entries: [{ url: SK_AGENT, kids: ['k1'] }, { url: SK_ORIGIN }],
    expectedKids: null,
  },
  {
    why: 'origin pinned, /mcp unpinned: unpinned for /mcp',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, kids: ['k1'] }, { url: SK_AGENT }],
    expectedKids: null,
  },
  {
    why: 'an empty signing_keys array is unpinned',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, kids: [] }, { url: SK_AGENT, kids: ['k1'] }],
    expectedKids: null,
  },
  // Both pin: the union.
  {
    why: 'both pinned with different keys: the union',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, kids: ['k1'] }, { url: SK_AGENT, kids: ['k2'] }],
    expectedKids: ['k1', 'k2'],
  },
  {
    why: 'both pinned with different keys, reverse order: the union in document order',
    agent: SK_AGENT,
    entries: [{ url: SK_AGENT, kids: ['k2'] }, { url: SK_ORIGIN, kids: ['k1'] }],
    expectedKids: ['k2', 'k1'],
  },
  {
    why: 'both pinned with overlapping keys: a shared key appears once',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, kids: ['k1', 'k2'] }, { url: SK_AGENT, kids: ['k2', 'k3'] }],
    expectedKids: ['k1', 'k2', 'k3'],
  },
  // An entry that does not match the agent never pins it nor unpins it.
  {
    why: 'an unpinned entry for another path does not unpin the agent',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, kids: ['k1'] }, { url: 'https://signer.example.com/a2a' }],
    expectedKids: ['k1'],
  },
  {
    why: 'an unpinned /mcp/ entry does not unpin /mcp (trailing slash is significant)',
    agent: SK_AGENT,
    entries: [{ url: SK_AGENT, kids: ['k1'] }, { url: `${SK_AGENT}/` }],
    expectedKids: ['k1'],
  },
  {
    why: 'a pinned entry for another path adds no key',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, kids: ['k1'] }, { url: 'https://signer.example.com/a2a', kids: ['k9'] }],
    expectedKids: ['k1'],
  },
  {
    why: 'agent at the origin: an unpinned /mcp entry does not match it',
    agent: SK_ORIGIN,
    entries: [{ url: SK_ORIGIN, kids: ['k1'] }, { url: SK_AGENT }],
    expectedKids: ['k1'],
  },
  // An entry outside its effective window authorizes nothing.
  {
    why: 'an expired unpinned origin entry does not unpin /mcp',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, effectiveUntil: '2020-01-01T00:00:00Z' }, { url: SK_AGENT, kids: ['k1'] }],
    expectedKids: ['k1'],
  },
  {
    why: 'an expired pinned entry adds no key and does not keep a pin',
    agent: SK_AGENT,
    entries: [{ url: SK_ORIGIN, kids: ['k9'], effectiveUntil: '2020-01-01T00:00:00Z' }, { url: SK_AGENT }],
    expectedKids: null,
  },
  // The 3.2 path: one exact match reads exactly as before.
  {
    why: 'one exact entry, pinned: its own keys',
    agent: SK_AGENT,
    entries: [{ url: SK_AGENT, kids: ['k1', 'k2'] }],
    expectedKids: ['k1', 'k2'],
  },
  {
    why: 'one exact entry, unpinned: no restriction',
    agent: SK_AGENT,
    entries: [{ url: SK_AGENT }],
    expectedKids: null,
  },
];

/** The JWK a fixture `kid` stands for. */
export function fixtureSigningKey(kid: string): { kid: string; kty: 'OKP'; crv: 'Ed25519'; alg: 'EdDSA'; x: string } {
  return { kid, kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', x: `x-${kid}` };
}

/** The `authorized_agents[]` entries a signing-key case lists. */
export function signingKeyCaseEntries(entries: readonly SigningKeyEntry[]): Array<Record<string, unknown>> {
  return entries.map(({ url, kids, effectiveUntil }) => ({
    url,
    authorized_for: 'Direct',
    ...(kids ? { signing_keys: kids.map(fixtureSigningKey) } : {}),
    ...(effectiveUntil ? { effective_until: effectiveUntil } : {}),
  }));
}
