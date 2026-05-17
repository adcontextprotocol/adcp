/**
 * Verify that an agent URL's hostname is owned by the registering org.
 *
 * MVP of #4499 (registration-time hostname verification). Catches the
 * escalation-#340 failure mode: an org registering an agent on a domain
 * it does not own (Adzymic claiming `adcp-mcp.celtra.com`). The check
 * compares the agent URL's hostname against `organization_domains` rows
 * marked `verified = true` for the caller's org. A match is exact-or-
 * subdomain: `apx.foo.example.com` matches a verified `foo.example.com`
 * or `example.com`; `evil.example.org` does NOT match `example.com`.
 *
 * What this does NOT yet do (later phases of #4499):
 *   - adagents.json delegation: agent's domain explicitly lists this org
 *     in its `authorized_agents`, so a third party can register on the
 *     brand's behalf without owning the domain.
 *   - DNS TXT challenge: caller proves control via a one-time token.
 *
 * Callers that need cross-org registration today must add the agent's
 * domain to their `organization_domains` (Linked Domains UI / WorkOS
 * domain verification) or have an AAO admin register it for them.
 */

import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-hostname-verification');

export type AgentHostnameVerification =
  | { ok: true; verified_domain: string; agent_hostname: string }
  | {
      ok: false;
      reason: 'invalid_url' | 'no_verified_domains' | 'hostname_not_in_verified_domains';
      agent_hostname: string;
      verified_domains: string[];
    };

export async function verifyAgentHostname(
  orgId: string,
  agentUrl: string,
): Promise<AgentHostnameVerification> {
  let hostname: string;
  try {
    hostname = new URL(agentUrl).hostname.toLowerCase();
  } catch {
    return {
      ok: false,
      reason: 'invalid_url',
      agent_hostname: '',
      verified_domains: [],
    };
  }
  if (!hostname) {
    return {
      ok: false,
      reason: 'invalid_url',
      agent_hostname: '',
      verified_domains: [],
    };
  }

  const pool = getPool();
  const r = await pool.query<{ domain: string }>(
    `SELECT domain FROM organization_domains
     WHERE workos_organization_id = $1 AND verified = true`,
    [orgId],
  );
  const verifiedDomains = r.rows.map((row) => row.domain.toLowerCase());

  if (verifiedDomains.length === 0) {
    return {
      ok: false,
      reason: 'no_verified_domains',
      agent_hostname: hostname,
      verified_domains: [],
    };
  }

  for (const d of verifiedDomains) {
    if (hostname === d || hostname.endsWith('.' + d)) {
      return { ok: true, verified_domain: d, agent_hostname: hostname };
    }
  }

  logger.warn(
    { orgId, hostname, verifiedDomains },
    'Agent hostname did not match any verified org domain',
  );
  return {
    ok: false,
    reason: 'hostname_not_in_verified_domains',
    agent_hostname: hostname,
    verified_domains: verifiedDomains,
  };
}

/**
 * Build a user-facing error message for an unverified hostname. Used
 * both by the REST POST/PATCH path and by the `save_agent` MCP tool
 * (which returns strings to Addie). Keeps the recovery copy in one
 * place so the two surfaces stay consistent.
 */
export function buildUnverifiedHostnameMessage(
  verification: Extract<AgentHostnameVerification, { ok: false }>,
): string {
  if (verification.reason === 'invalid_url') {
    return 'Invalid agent URL — could not parse hostname.';
  }
  if (verification.reason === 'no_verified_domains') {
    return (
      'Your organization has no verified domains, so we cannot confirm ' +
      'you own the agent URL. Verify a domain via the Linked Domains UI ' +
      '(Settings → Organization → Domains) first, then retry.'
    );
  }
  const domainList = verification.verified_domains.join(', ');
  return (
    `Agent hostname "${verification.agent_hostname}" is not on a verified domain ` +
    `for your organization. Your verified domains: ${domainList}. ` +
    `Add "${verification.agent_hostname}" (or its parent domain) to your linked ` +
    `domains, or have an AAO admin register the agent for you.`
  );
}
