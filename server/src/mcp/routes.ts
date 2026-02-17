/**
 * MCP Route Handlers
 *
 * Configures Express routes for the MCP server:
 * - POST /mcp - MCP JSON-RPC endpoint (auth required, rate limited)
 * - OAuth endpoints via SDK's mcpAuthRouter (authorize, token, register, metadata)
 * - OPTIONS /mcp - CORS preflight
 *
 * OAuth 2.1 is brokered via MCPOAuthProvider: registration and PKCE
 * are handled locally, user authentication delegates to AuthKit.
 * The SDK's mcpAuthRouter handles all discovery and OAuth endpoints:
 * - /.well-known/oauth-authorization-server
 * - /.well-known/oauth-protected-resource/mcp
 * - /authorize, /token, /register
 */

import type { Router, Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { PostgresStore } from '../middleware/pg-rate-limit-store.js';
import { createUnifiedMCPServer } from './server.js';
import { createOAuthProvider, MCP_AUTH_ENABLED } from './oauth-provider.js';
import {
  authInfoToMCPAuthContext,
  anonymousAuthContext,
  type MCPAuthenticatedRequest,
} from './auth.js';

const logger = createLogger('mcp-routes');

/**
 * Externally-reachable URL of this server.
 * Used as the OAuth issuer URL and for resource metadata.
 *
 * In production, BASE_URL defaults to https://agenticadvertising.org.
 * In development, defaults to http://localhost:{PORT}.
 */
const MCP_SERVER_URL = (
  process.env.BASE_URL ||
  `http://localhost:${process.env.PORT || process.env.CONDUCTOR_PORT || '3000'}`
).replace(/\/$/, '');

/**
 * Rate limiter for MCP endpoint
 * 10 requests per minute per authenticated user
 */
const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresStore('mcp:'),
  keyGenerator: (req: MCPAuthenticatedRequest) => {
    return `user:${req.mcpAuth?.sub || 'anonymous'}`;
  },
  handler: (_req, res) => {
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
  const provider = createOAuthProvider();

  // Mount SDK's OAuth router (handles metadata, authorize, token, register)
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(MCP_SERVER_URL),
      resourceServerUrl: new URL(`${MCP_SERVER_URL}/mcp`),
      scopesSupported: ['openid', 'profile', 'email'],
    })
  );

  // CORS preflight for MCP endpoint
  router.options('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  // Build the MCP POST middleware chain
  const mcpMiddleware: Array<(req: MCPAuthenticatedRequest, res: Response, next: NextFunction) => void> = [];

  if (MCP_AUTH_ENABLED) {
    // Bearer token validation via SDK
    mcpMiddleware.push(requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: `${MCP_SERVER_URL}/.well-known/oauth-protected-resource/mcp`,
    }) as (
      req: MCPAuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ) => void);

    // Bridge: convert SDK's req.auth (AuthInfo) → req.mcpAuth (MCPAuthContext)
    mcpMiddleware.push((req: MCPAuthenticatedRequest, _res: Response, next: NextFunction) => {
      if (req.auth) {
        req.mcpAuth = authInfoToMCPAuthContext(req.auth);
      } else {
        logger.warn('MCP: requireBearerAuth passed but req.auth is missing');
        req.mcpAuth = anonymousAuthContext();
      }
      next();
    });
  } else {
    // Dev mode: attach anonymous auth context
    mcpMiddleware.push((req: MCPAuthenticatedRequest, _res: Response, next: NextFunction) => {
      req.mcpAuth = anonymousAuthContext();
      next();
    });
  }

  // MCP POST handler
  router.post(
    '/mcp',
    ...mcpMiddleware,
    mcpRateLimiter,
    async (req: MCPAuthenticatedRequest, res: Response) => {
      setCORSHeaders(res);

      let server: ReturnType<typeof createUnifiedMCPServer> | null = null;
      try {
        server = createUnifiedMCPServer(req.mcpAuth);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode
        });

        await server.connect(transport);

        const isAuthenticated = req.mcpAuth?.sub && req.mcpAuth.sub !== 'anonymous';
        logger.debug({
          authenticated: isAuthenticated,
          sub: req.mcpAuth?.sub,
          method: req.body?.method,
          ip: req.ip,
        }, 'MCP: Handling request');

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
        await server?.close().catch(() => {});
      }
    }
  );

  // MCP GET handler - not supported in stateless mode
  router.get('/mcp', (_req: Request, res: Response) => {
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
  router.delete('/mcp', (_req: Request, res: Response) => {
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

  logger.info({ authEnabled: MCP_AUTH_ENABLED, serverUrl: MCP_SERVER_URL }, 'MCP: Routes configured');
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
