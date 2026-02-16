/**
 * MCP Module
 *
 * Unified MCP server combining all Addie capabilities:
 * - Knowledge search (docs, repos, Slack, external resources)
 * - Directory lookup (members, agents, publishers)
 * - Billing operations (membership products, payment links)
 *
 * Authentication via OAuth 2.1 (WorkOS AuthKit), proxied through
 * the MCP SDK's ProxyOAuthServerProvider.
 */

export { createUnifiedMCPServer, initializeMCPServer, isMCPServerReady, getAllTools } from './server.js';
export { configureMCPRoutes } from './routes.js';
export { createOAuthProvider, AUTHKIT_ISSUER, MCP_AUTH_ENABLED } from './oauth-provider.js';
export {
  authInfoToMCPAuthContext,
  anonymousAuthContext,
  type MCPAuthContext,
  type MCPAuthenticatedRequest,
} from './auth.js';
