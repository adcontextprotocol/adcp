/** Canonical training agent hostname and URL. */
export const TRAINING_AGENT_HOSTNAME = 'test-agent.adcontextprotocol.org';
export const TRAINING_AGENT_URL = `https://${TRAINING_AGENT_HOSTNAME}`;

/** DNS alias — some published docs reference this hostname. */
export const TRAINING_AGENT_HOSTNAME_LEGACY = 'testing.adcontextprotocol.org';

/** All hostnames that resolve to the training agent. */
export const TRAINING_AGENT_HOSTNAMES = new Set([
  TRAINING_AGENT_HOSTNAME,
  TRAINING_AGENT_HOSTNAME_LEGACY,
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
