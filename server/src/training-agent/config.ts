/** Canonical training agent hostname and URL. */
export const TRAINING_AGENT_HOSTNAME = 'test-agent.adcontextprotocol.org';
export const TRAINING_AGENT_URL = `https://${TRAINING_AGENT_HOSTNAME}`;

/** Deprecated hostname — redirects to the validation guide. */
export const TRAINING_AGENT_HOSTNAME_DEPRECATED = 'testing.adcontextprotocol.org';

/** All hostnames that resolve to the training agent. */
export const TRAINING_AGENT_HOSTNAMES = new Set([
  TRAINING_AGENT_HOSTNAME,
]);

/**
 * Resolve the agent URL for format references and catalog links.
 * In local dev (no TRAINING_AGENT_URL set), returns the canonical production URL.
 * This is fine because local calls hit the in-process shortcut and never make HTTP requests.
 */
export function getAgentUrl(): string {
  if (process.env.TRAINING_AGENT_URL) {
    return process.env.TRAINING_AGENT_URL.replace(/\/$/, '');
  }
  return TRAINING_AGENT_URL;
}

/**
 * Base of the advertised `identity.brand_json_url`. Defaults to the agent URL.
 * The local storyboard runner sets `TRAINING_AGENT_IDENTITY_URL` only while it
 * points `TRAINING_AGENT_URL` at its http loopback for `requires: [multi_agent]`
 * storyboards: those flows never fetch brand.json, but AdCP 3.2+ requires an
 * https `brand_json_url`, and SDK 16.5+ fails discovery for capability-gated
 * storyboards on a schema-invalid capabilities response. Deployments never set it.
 */
export function getIdentityBaseUrl(): string {
  const identity = process.env.TRAINING_AGENT_IDENTITY_URL?.trim().replace(/\/+$/, '');
  return identity || getAgentUrl();
}

/**
 * Resolve a module's `tenant_ids` to per-tenant URLs. Order is significant —
 * the first id is "primary" (the URL Sage hands the learner first); later ids
 * are "also in scope" for tools the primary doesn't serve.
 *
 * Empty / null `tenantIds` returns the legacy single-URL alias (`{base}/mcp`)
 * — same behavior the cert flow had before per-module pinning. Sage falls
 * back to the discovery extension on `/.well-known/adagents.json` from there.
 */
export interface ModuleTenantUrls {
  /** First URL in `all`. The agent Sage should hand the learner first. */
  primary: string;
  /** All resolved URLs, in declared order. Length 1 = single-tenant module. */
  all: string[];
  /** Tenant ids in declared order. Empty = no pinning (fell back to /mcp). */
  ids: string[];
}

export function tenantUrlsForModule(
  tenantIds: string[] | null | undefined,
  baseUrl?: string,
): ModuleTenantUrls {
  const base = (baseUrl || getAgentUrl()).replace(/\/$/, '');
  if (!tenantIds || tenantIds.length === 0) {
    const legacy = `${base}/mcp`;
    return { primary: legacy, all: [legacy], ids: [] };
  }
  const all = tenantIds.map((id) => `${base}/${id}/mcp`);
  return { primary: all[0], all, ids: [...tenantIds] };
}
