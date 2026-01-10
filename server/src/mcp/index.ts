/**
 * MCP Module
 *
 * Unified MCP server combining all Addie capabilities:
 * - Knowledge search (docs, repos, Slack, external resources)
 * - Directory lookup (members, agents, publishers)
 * - Billing operations (membership products, payment links)
 *
 * Access modes:
 * - Authenticated (OAuth 2.1): Full tools based on membership (10/min)
 * - Anonymous: Knowledge tools only, rate limited by IP (5/min)
 */

export { createUnifiedMCPServer, initializeMCPServer, isMCPServerReady, getAllTools } from './server.js';
export { configureMCPRoutes } from './routes.js';
export {
  optionalMcpAuthMiddleware,
  getOAuthProtectedResourceMetadata,
  getAuthorizationServerMetadataUrl,
  MCP_AUTH_ENABLED,
  type MCPAuthContext,
  type MCPAuthenticatedRequest,
} from './auth.js';
