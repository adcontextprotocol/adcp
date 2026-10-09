/**
 * Resolve the canonical path-routed training-agent base without importing the
 * tenant registry. Keeping this dependency-free prevents leaf task handlers
 * from cycling through registry -> tenant platform -> aggregate catalog.
 */
export function getCanonicalBase(): string {
  const candidates = [process.env.BASE_URL, process.env.TRAINING_AGENT_URL];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim().replace(/\/$/, '');
    try {
      const url = new URL(trimmed);
      if (url.host) return trimmed;
    } catch {
      // Invalid candidates fall through to the local canonical base.
    }
  }
  return 'http://localhost';
}

const TRAINING_AGENT_PUBLIC_URL = 'https://test-agent.adcontextprotocol.org';

/**
 * `iss` of every governance token this deployment's `/governance` tenant
 * signs, and the URL a buyer registers through `sync_governance` to name
 * this governance service. Governed tenants in the same deployment expect
 * exactly this value.
 *
 * It is the training agent's own URL, not `${canonicalBase}/governance`:
 * the storyboards register `https://test-agent.adcontextprotocol.org` as the
 * governance agent, a third-party seller verifies `iss` byte-for-byte
 * against that registered URL, fetches the revocation list from the
 * issuer's origin, and calls `check_governance` at that URL (served by the
 * root MCP route). Production resolves to the public training-agent URL;
 * local and CI runs set `TRAINING_AGENT_URL` to the local mount. Never has
 * a trailing slash.
 */
export function getTrainingGovernanceIssuer(): string {
  const configured = process.env.TRAINING_AGENT_URL?.trim().replace(/\/+$/, '');
  if (configured) {
    try {
      if (new URL(configured).host) return configured;
    } catch {
      // Invalid values fall through to the public URL, as getAgentUrl() does.
    }
  }
  return TRAINING_AGENT_PUBLIC_URL;
}
