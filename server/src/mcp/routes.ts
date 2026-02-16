/**
 * MCP Route Handlers
 *
 * Configures Express routes for the unified MCP server:
 * - POST /mcp - MCP JSON-RPC endpoint (auth required, rate limited)
 * - GET /.well-known/oauth-protected-resource - OAuth resource metadata (RFC 9728)
 * - OPTIONS /mcp - CORS preflight
 *
 * Authentication via OAuth 2.1 (WorkOS AuthKit).
 * WorkOS handles dynamic client registration (RFC 7591), authorization,
 * and token issuance. This server validates bearer tokens via JWKS.
 *
 * Clients discover the authorization server via the Protected Resource Metadata
 * endpoint (RFC 9728), which points them to AuthKit directly.
 */

import type { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { createUnifiedMCPServer } from './server.js';
import {
  mcpAuthMiddleware,
  getOAuthProtectedResourceMetadata,
  MCP_AUTH_ENABLED,
  type MCPAuthenticatedRequest,
} from './auth.js';

const logger = createLogger('mcp-routes');

/**
 * Rate limiter for MCP endpoint
 * 10 requests per minute per authenticated user
 */
const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: MCPAuthenticatedRequest) => {
    return `user:${req.mcpAuth?.sub || 'anonymous'}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Rate limit exceeded. Try again later.',
      },
    });
  },
});

/**
 * Configure MCP routes on an Express router
 */
export function configureMCPRoutes(router: Router): void {
  // OAuth Protected Resource Metadata (RFC 9728)
  // MCP clients use this to discover where to authenticate
  const servePRM = (req: Request, res: Response) => {
    const metadata = getOAuthProtectedResourceMetadata(req);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(metadata);
  };

  router.get('/.well-known/oauth-protected-resource', servePRM);
  // Path-specific PRM per RFC 9728 (for /mcp resource path)
  router.get('/.well-known/oauth-protected-resource/mcp', servePRM);

  // CORS preflight for MCP endpoint
  router.options('/mcp', (req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  // MCP POST handler - main endpoint
  // Auth required: returns 401 with OAuth discovery metadata for unauthenticated requests
  // Rate limited: 10/min per user
  router.post(
    '/mcp',
    mcpAuthMiddleware,
    mcpRateLimiter,
    async (req: MCPAuthenticatedRequest, res: Response) => {
      setCORSHeaders(res);

      let server: ReturnType<typeof createUnifiedMCPServer> | null = null;
      try {
        // Create a new MCP server and transport for each request (stateless mode)
        server = createUnifiedMCPServer(req.mcpAuth);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode - no sessions
        });

        // Connect server to transport
        await server.connect(transport);

        // Log request with auth context
        const isAuthenticated = req.mcpAuth?.sub && req.mcpAuth.sub !== 'anonymous';
        logger.debug({
          authenticated: isAuthenticated,
          sub: req.mcpAuth?.sub,
          method: req.body?.method,
          ip: req.ip,
        }, 'MCP: Handling request');

        // Handle the request
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error({ error }, 'MCP: Request handling error');

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32603,
              message: 'Internal server error',
            },
          });
        }
      } finally {
        // Clean up per-request server to avoid event listener leaks
        await server?.close().catch(() => {});
      }
    }
  );

  // MCP GET handler - not supported in stateless mode
  router.get('/mcp', (req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Method not allowed. Use POST for MCP requests.',
      },
    });
  });

  // MCP DELETE handler - not needed in stateless mode
  router.delete('/mcp', (req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Method not allowed. Session management not supported in stateless mode.',
      },
    });
  });

  logger.info({ authEnabled: MCP_AUTH_ENABLED }, 'MCP: Routes configured');
}

/**
 * Set CORS headers for MCP endpoint
 */
function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Content-Type');
}
