/**
 * Reference creative agent route setup.
 *
 * Mounts the MCP endpoint at /api/creative-agent/mcp and a preview
 * hosting endpoint at /api/creative-agent/preview/:id.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from '../logger.js';
import { createCreativeAgentServer } from './task-handlers.js';
import { getPreview, cleanExpiredPreviews } from './preview-store.js';

const logger = createLogger('creative-agent-routes');

const CREATIVE_AGENT_TOKEN = process.env.CREATIVE_AGENT_TOKEN;
const STARTUP_TIME = new Date().toISOString();

function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!CREATIVE_AGENT_TOKEN) {
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), CREATIVE_AGENT_TOKEN)) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Invalid or missing bearer token' },
    });
    return;
  }
  next();
}

const CREATIVE_AGENT_HOST = 'creative.adcontextprotocol.org';

/**
 * Resolve the agent base URL from the request.
 * When accessed via the dedicated creative.adcontextprotocol.org hostname,
 * routes are at root, so the agent base is just the origin.
 * Otherwise, the agent is mounted at /api/creative-agent under the main app.
 */
function getAgentBaseUrl(req: Request): string {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (typeof host === 'string' && host.startsWith(CREATIVE_AGENT_HOST)) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${CREATIVE_AGENT_HOST}`;
  }
  const baseUrl = process.env.BASE_URL
    ? process.env.BASE_URL.replace(/\/$/, '')
    : `${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${host}`;
  return `${baseUrl}/api/creative-agent`;
}

export function createCreativeAgentRouter(): Router {
  const router = Router();

  // Clean expired previews every 5 minutes
  const cleanupInterval = setInterval(() => cleanExpiredPreviews(), 5 * 60 * 1000);
  cleanupInterval.unref();

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', service: 'creative-agent' });
  });

  // adagents.json discovery
  router.get('/.well-known/adagents.json', (req: Request, res: Response) => {
    const agentBaseUrl = getAgentBaseUrl(req);

    res.json({
      $schema: '/schemas/adagents.json',
      contact: {
        name: 'AdCP Reference Creative Agent',
        url: 'https://adcontextprotocol.org',
      },
      agents: [{
        url: `${agentBaseUrl}/mcp`,
        type: 'creative',
        capabilities: ['list_creative_formats', 'preview_creative'],
      }],
      last_updated: STARTUP_TIME,
    });
  });

  // CORS preflight
  router.options('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  // Rate limiting
  const mcpRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, ip: false },
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Rate limit exceeded. Please try again later.' },
      });
    },
  });

  // MCP endpoint
  router.post('/mcp', mcpRateLimiter, requireToken, async (req: Request, res: Response) => {
    setCORSHeaders(res);

    let server: ReturnType<typeof createCreativeAgentServer> | null = null;
    try {
      const agentBaseUrl = getAgentBaseUrl(req);
      server = createCreativeAgentServer(agentBaseUrl);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      logger.debug({ method: req.body?.method, ip: req.ip }, 'Creative agent: handling request');

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ error }, 'Creative agent: request error');
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
  });

  // GET/DELETE not supported (stateless server — no SSE streams or session termination)
  router.get('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });

  router.delete('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });

  // Preview hosting endpoint
  router.get('/preview/:id', (req: Request, res: Response) => {
    const html = getPreview(req.params.id);
    if (!html) {
      res.status(404).send('Preview not found or expired');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors *");
    res.send(html);
  });

  logger.info('Creative agent routes configured');
  return router;
}
