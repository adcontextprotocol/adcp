/**
 * Governance agent MCP route handler.
 *
 * Mounts at /governance/mcp. Authentication is via Bearer token matching
 * the credentials from sync_accounts governance_agent configuration.
 *
 * Unlike the Addie MCP endpoint (OAuth 2.1 + WorkOS), this endpoint uses
 * simple Bearer token auth — the token is the credential the buyer provides
 * when configuring their governance_agent in sync_accounts.
 *
 * Token validation: The token is looked up in the governance_credentials table.
 * Buyers register credentials via sync_accounts; the seller stores the token hash
 * and maps it to an account_id. This prevents token forgery.
 */

import type { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../logger.js';
import { PostgresStore } from '../middleware/pg-rate-limit-store.js';
import { createGovernanceServer } from './server.js';
import { lookupGovernanceToken } from '../db/governance-db.js';

const logger = createLogger('governance-routes');

/**
 * Rate limiter for governance endpoint.
 * 60 requests per minute per Bearer token — governance checks are frequent.
 */
const governanceRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresStore('governance:'),
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (!auth) return 'anonymous';
    // Hash the token for rate limit key — never store raw tokens
    return `gov:${createHash('sha256').update(auth).digest('hex').slice(0, 16)}`;
  },
  handler: (_req, res) => {
    res.status(429).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Rate limit exceeded.' },
    });
  },
});

/**
 * Authenticate a governance request via Bearer token lookup.
 *
 * Returns the account_id associated with the token, or null if invalid.
 */
async function authenticateRequest(req: Request): Promise<string | null> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7);
  // Always hash before returning to avoid timing side-channels on token length
  const tokenHash = createHash('sha256').update(token).digest('hex');
  if (token.length < 32) return null;

  return lookupGovernanceToken(tokenHash);
}

/**
 * Configure governance MCP routes on an Express router.
 *
 * This is a server-to-server endpoint (agents calling agents).
 * No CORS headers — browsers do not call this directly.
 */
export function configureGovernanceRoutes(router: Router): void {
  // Governance MCP endpoint
  router.post(
    '/governance/mcp',
    governanceRateLimiter,
    async (req: Request, res: Response) => {
      // Authenticate
      const accountId = await authenticateRequest(req);
      if (!accountId) {
        res.status(401).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Invalid or missing Bearer token.' },
        });
        return;
      }

      let server: ReturnType<typeof createGovernanceServer> | null = null;
      try {
        server = createGovernanceServer(accountId);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless
        });

        await server.connect(transport);

        logger.debug({
          accountId,
          method: req.body?.method,
        }, 'Governance: Handling request');

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error({ error }, 'Governance: Request handling error');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal server error' },
          });
        }
      } finally {
        await server?.close().catch(() => {});
      }
    }
  );

  // Method not allowed for other HTTP methods
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
    });
  };

  router.get('/governance/mcp', methodNotAllowed);
  router.delete('/governance/mcp', methodNotAllowed);

  logger.info('Governance: MCP routes configured at /governance/mcp');
}
