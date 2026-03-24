/** Canonical training agent hostname and URL. */
export const TRAINING_AGENT_HOSTNAME = 'test-agent.adcontextprotocol.org';
export const TRAINING_AGENT_URL = `https://${TRAINING_AGENT_HOSTNAME}`;

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
