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
 * **Only verified domains count.** An earlier MVP iteration fell back
 * to `organizations.email_domain` when an org had no verified-domain
 * rows. The security review on #4648 surfaced that `email_domain` is
 * not a trustworthy claim: `/api/me/brand-claim/issue` lets a member
 * ask WorkOS to register any domain (e.g. `celtra.com`), WorkOS
 * accepts the create in DNS-pending state, and the `organization.updated`
 * webhook writes `email_domain` from that unverified row when it's
 * first/primary. An attacker org with no verified domains could
 * therefore claim someone else's domain and pass the soft-pass — the
 * exact escalation-#340 shape. The fallback is removed: when the org
 * has zero verified-domain rows the gate rejects, regardless of what
 * `email_domain` says. Personal workspaces and orgs that haven't
 * completed WorkOS domain verification must go through Linked Domains
 * (or have an admin register on their behalf) first.
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
      reason:
        | 'invalid_url'
        | 'no_verified_domains'
        | 'hostname_not_in_verified_domains';
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
    logger.warn(
      { orgId, hostname },
      'Agent registration rejected — org has no verified domains',
    );
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
 * True when the verification result is a *hostname-ownership* rejection
 * the caller should surface as 400 `unverified_hostname`. `invalid_url`
 * is a separate kind of error (parser failure) and should be surfaced
 * with its own message by the caller — it isn't a claim-violation.
 *
 * Exhaustive on the `reason` union via a `never`-typed fallthrough so a
 * future rejection reason added to `AgentHostnameVerification` fails
 * to compile until this guard is updated. Without that, the union and
 * the guard could drift, silently admitting a smuggle.
 */
export function isHostnameOwnershipRejection(
  v: AgentHostnameVerification,
): v is Extract<AgentHostnameVerification, { ok: false }> & {
  reason: 'hostname_not_in_verified_domains' | 'no_verified_domains';
} {
  if (v.ok) return false;
  switch (v.reason) {
    case 'invalid_url':
      return false;
    case 'no_verified_domains':
    case 'hostname_not_in_verified_domains':
      return true;
    default: {
      const _exhaustive: never = v.reason;
      throw new Error(`Unknown AgentHostnameVerification.reason: ${_exhaustive as string}`);
    }
  }
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
