/**
 * Public test agent credentials.
 * These are intentionally public and documented for testing purposes.
 * See: https://docs.adcontextprotocol.org/docs/media-buy/advanced-topics/sandbox
 *
 * The token can be overridden via PUBLIC_TEST_AGENT_TOKEN env var if needed,
 * but defaults to the documented public token.
 *
 * URL: defaults to the `/sales/mcp` per-specialism tenant — most callers
 * (`get_products`, `create_media_buy`, the demo flows in Sage and Addie)
 * exercise the sales surface. Other specialisms live at sibling URLs:
 * `/signals/mcp`, `/governance/mcp`, `/creative/mcp`,
 * `/creative-builder/mcp`, `/brand/mcp`. The legacy single-URL
 * `/mcp` continues to serve the v5 monolith via the back-compat alias for
 * AAO entries and external callers that haven't migrated.
 */
export const PUBLIC_TEST_AGENT = {
  url: process.env.PUBLIC_TEST_AGENT_URL || 'https://test-agent.adcontextprotocol.org/sales/mcp',
  token: process.env.PUBLIC_TEST_AGENT_TOKEN || '1v8tAhASaUYYp' + '4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ',
  name: 'AdCP Public Test Agent',
};

/**
 * Per-specialism test-agent URLs. Use when steering a caller at a non-sales
 * specialism (e.g., signals labs, governance demos). All resolve to the
 * same Fly app via host-based dispatch.
 */
export const PUBLIC_TEST_AGENT_URLS = {
  sales: 'https://test-agent.adcontextprotocol.org/sales/mcp',
  signals: 'https://test-agent.adcontextprotocol.org/signals/mcp',
  governance: 'https://test-agent.adcontextprotocol.org/governance/mcp',
  creative: 'https://test-agent.adcontextprotocol.org/creative/mcp',
  'creative-builder': 'https://test-agent.adcontextprotocol.org/creative-builder/mcp',
  brand: 'https://test-agent.adcontextprotocol.org/brand/mcp',
  /** Back-compat alias serving the v5 single-URL training agent. */
  legacy: 'https://test-agent.adcontextprotocol.org/mcp',
} as const;

// Internal path URL — redirect to the canonical hostname.
// Kept as the legacy single-URL form because existing `agent_contexts` rows
// reference it; the redirect target (PUBLIC_TEST_AGENT.url) is now the sales
// tenant on the canonical hostname.
export const INTERNAL_PATH_AGENT_URL = 'https://agenticadvertising.org/api/training-agent/mcp';
