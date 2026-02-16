/**
 * MCP Route Handlers
 *
 * Configures Express routes for the unified MCP server:
 * - POST /mcp - MCP JSON-RPC endpoint (auth required, rate limited)
 * - GET /.well-known/oauth-protected-resource - OAuth resource metadata (RFC 9728)
 * - GET /.well-known/oauth-authorization-server - Proxied AS metadata (RFC 8414)
 * - OPTIONS /mcp - CORS preflight
 *
 * Authentication via OAuth 2.1 (WorkOS AuthKit).
 * WorkOS handles dynamic client registration (RFC 7591), authorization,
 * and token issuance. This server validates bearer tokens via JWKS.
 *
 * OAuth discovery is served both via PRM (RFC 9728) and by proxying AuthKit's
 * AS metadata (RFC 8414). Some clients (e.g. ChatGPT) fetch AS metadata
 * directly from the MCP server rather than following the PRM flow.
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
  AUTHKIT_ISSUER,
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

  // OAuth Authorization Server Metadata proxy (RFC 8414)
  // Some MCP clients (ChatGPT) fetch AS metadata from the resource server
  // rather than following PRM's authorization_servers URL.
  let asMetadataCache: { data: unknown; expiresAt: number } | null = null;
  const AS_METADATA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  const serveASMetadata = async (req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (asMetadataCache && now < asMetadataCache.expiresAt) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json(asMetadataCache.data);
        return;
      }

      const response = await fetch(
        `${AUTHKIT_ISSUER}/.well-known/oauth-authorization-server`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) {
        logger.error({ status: response.status }, 'MCP: Failed to fetch AS metadata');
        res.status(502).json({ error: 'Failed to fetch authorization server metadata' });
        return;
      }
      const metadata = await response.json();
      asMetadataCache = { data: metadata, expiresAt: now + AS_METADATA_CACHE_TTL_MS };
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(metadata);
    } catch (error) {
      logger.error({ error }, 'MCP: Error proxying AS metadata');
      res.status(502).json({ error: 'Failed to fetch authorization server metadata' });
    }
  };

  router.get('/.well-known/oauth-authorization-server', serveASMetadata);
  // Path-specific AS metadata per RFC 8414 (ChatGPT requests this variant)
  router.get('/.well-known/oauth-authorization-server/mcp', serveASMetadata);

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
