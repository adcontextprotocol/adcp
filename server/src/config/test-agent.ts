/**
 * Public test agent credentials.
 * These are intentionally public and documented for testing purposes.
 * See: https://docs.adcontextprotocol.org/docs/media-buy/advanced-topics/sandbox
 *
 * The token can be overridden via PUBLIC_TEST_AGENT_TOKEN env var if needed,
 * but defaults to the documented public token.
 */
export const PUBLIC_TEST_AGENT = {
  url: process.env.PUBLIC_TEST_AGENT_URL || 'https://test-agent.adcontextprotocol.org/mcp',
  token: process.env.PUBLIC_TEST_AGENT_TOKEN || '1v8tAhASaUYYp' + '4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ',
  name: 'AdCP Public Test Agent',
};

// Internal path URL — redirect to the canonical hostname
export const INTERNAL_PATH_AGENT_URL = 'https://agenticadvertising.org/api/training-agent/mcp';
