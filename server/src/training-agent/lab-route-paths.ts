/**
 * Single source of truth for the training agent's multi-segment lab MCP
 * routes. Kept dependency-free so transport middleware (CSRF) can import it
 * without pulling in the training-agent handler graph. On
 * test-agent.adcontextprotocol.org these paths are served at the root, where
 * the single-segment `/<tenant>/mcp` CSRF exemption does not match them.
 */
export const PROPOSAL_NEGOTIATION_PROFILE_PATHS = [
  '/sales/profiles/typed-negotiation/mcp',
  '/sales/profiles/constrained-seller/mcp',
  '/sales/profiles/finalization-failure/mcp',
] as const;

/** Experimental AdCP 3.3 identity route: Web Bot Auth and demand-side grants. */
export const IDENTITY33_ROUTE = '/sales/identity/mcp';

/** Isolated creative workflows on the frozen 3.3 beta contract. */
export const CREATIVE33_MCP_ROUTE = '/beta/3.3/creative/mcp';

/** Match the casing and trailing slash aliases accepted by Express, before
 * mounts strip the internal API prefix. Only used to retain exact body bytes. */
export function isCreative33McpPath(url: string | undefined): boolean {
  const pathname = url?.split('?')[0].replace(/\/$/, '').toLowerCase();
  return pathname === CREATIVE33_MCP_ROUTE || pathname === `/api/training-agent${CREATIVE33_MCP_ROUTE}`;
}

/** Bearer- or signature-authenticated lab routes; never cookie-authenticated. */
export const TRAINING_AGENT_LAB_MCP_PATHS: readonly string[] = [...PROPOSAL_NEGOTIATION_PROFILE_PATHS, IDENTITY33_ROUTE, CREATIVE33_MCP_ROUTE];
