/**
 * MCP Module
 *
 * Unified MCP server combining all Addie capabilities:
 * - Knowledge search (docs, repos, Slack, external resources)
 * - Directory lookup (members, agents, publishers)
 * - Billing operations (membership products, payment links)
 *
 * Authentication via OAuth 2.1 (WorkOS AuthKit), brokered through
 * MCPOAuthProvider which handles registration and PKCE locally.
 */

export { createUnifiedMCPServer, initializeMCPServer, isMCPServerReady, getAllTools } from './server.js';
export { configureMCPRoutes } from './routes.js';
export { createOAuthProvider, handleMCPOAuthCallback, AUTHKIT_ISSUER, MCP_AUTH_ENABLED } from './oauth-provider.js';
export {
  authInfoToMCPAuthContext,
  anonymousAuthContext,
  type MCPAuthContext,
  type MCPAuthenticatedRequest,
} from './auth.js';
