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
