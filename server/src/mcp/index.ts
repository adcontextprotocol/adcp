/**
 * MCP Module
 *
 * Unified MCP server combining all Addie capabilities:
 * - Knowledge search (docs, repos, Slack, external resources)
 * - Directory lookup (members, agents, publishers)
 * - Billing operations (membership products, payment links)
 *
 * Authentication required via OAuth 2.1 (WorkOS AuthKit).
 * Unauthenticated requests receive 401 with OAuth discovery metadata.
 */

export { createUnifiedMCPServer, initializeMCPServer, isMCPServerReady, getAllTools } from './server.js';
export { configureMCPRoutes } from './routes.js';
export {
  mcpAuthMiddleware,
  getOAuthProtectedResourceMetadata,
  getAuthorizationServerMetadataUrl,
  MCP_AUTH_ENABLED,
  type MCPAuthContext,
  type MCPAuthenticatedRequest,
} from './auth.js';
