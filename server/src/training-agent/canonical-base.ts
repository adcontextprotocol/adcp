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

/**
 * `iss` of every governance token this deployment's `/governance` tenant
 * signs. Governed tenants in the same deployment expect exactly this value,
 * so it follows the deployment's canonical base: the production canonical
 * base in production, the local origin in local and CI runs.
 */
export function getTrainingGovernanceIssuer(): string {
  return `${getCanonicalBase()}/governance`;
}
