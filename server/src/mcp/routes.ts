/**
 * MCP Route Handlers
 *
 * Configures Express routes for the unified MCP server:
 * - POST /mcp - MCP JSON-RPC endpoint (optional auth, rate limited)
 * - GET /.well-known/oauth-protected-resource - OAuth resource metadata
 * - OPTIONS /mcp - CORS preflight
 *
 * Access modes:
 * - Authenticated: Full tools based on membership
 * - Anonymous: Knowledge tools only, rate limited by IP
 */

import type { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import rateLimit from 'express-rate-limit';
import { ipKeyGenerator } from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { createUnifiedMCPServer } from './server.js';
import {
  optionalMcpAuthMiddleware,
  getOAuthProtectedResourceMetadata,
  MCP_AUTH_ENABLED,
  type MCPAuthenticatedRequest,
} from './auth.js';

const logger = createLogger('mcp-routes');

/**
 * Rate limiter for MCP endpoint
 * Anonymous: 5 requests per minute per IP
 * Authenticated: 10 requests per minute per user
 */
const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (req: MCPAuthenticatedRequest) => {
    // Authenticated users get slightly higher limits
    if (req.mcpAuth?.sub && req.mcpAuth.sub !== 'anonymous') {
      return 10; // 10 requests per minute for authenticated users
    }
    return 5; // 5 requests per minute for anonymous
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: MCPAuthenticatedRequest) => {
    // Use user ID for authenticated, IP for anonymous
    if (req.mcpAuth?.sub && req.mcpAuth.sub !== 'anonymous') {
      return `user:${req.mcpAuth.sub}`;
    }
    // Use ipKeyGenerator helper to handle IPv6 properly
    return ipKeyGenerator(req.ip || 'unknown');
  },
  handler: (req, res) => {
    res.status(429).json({
      jsonrpc: '2.0',
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
  // OAuth Protected Resource Metadata
  // MCP clients use this to discover where to authenticate
  router.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const metadata = getOAuthProtectedResourceMetadata(req);
    logger.debug({ metadata }, 'MCP: Serving resource metadata');
    res.json(metadata);
  });

  // CORS preflight for MCP endpoint
  router.options('/mcp', (req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  // MCP POST handler - main endpoint
  // Auth is optional: authenticated users get full tools, anonymous get knowledge tools only
  // Rate limited: 20/min anonymous, 100/min authenticated
  router.post(
    '/mcp',
    optionalMcpAuthMiddleware,
    mcpRateLimiter,
    async (req: MCPAuthenticatedRequest, res: Response) => {
      setCORSHeaders(res);

      try {
        // Create a new MCP server and transport for each request (stateless mode)
        const server = createUnifiedMCPServer();
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
            error: {
              code: -32603,
              message: 'Internal server error',
            },
          });
        }
      }
    }
  );

  // MCP GET handler - not supported in stateless mode
  router.get('/mcp', (req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: 'Method not allowed. Use POST for MCP requests.',
      },
    });
  });

  // MCP DELETE handler - not needed in stateless mode
  router.delete('/mcp', (req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
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
}
