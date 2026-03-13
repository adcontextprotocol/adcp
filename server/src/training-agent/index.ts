/**
 * Training agent route setup.
 *
 * Mounts the MCP endpoint at /api/training-agent/mcp with simple
 * bearer token auth, CORS, and adagents.json discovery.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from '../logger.js';
import { createTrainingAgentServer } from './task-handlers.js';
import { startSessionCleanup } from './state.js';
import { PUBLISHERS } from './publishers.js';
import type { TrainingContext } from './types.js';

const logger = createLogger('training-agent-routes');

const TRAINING_AGENT_TOKEN = process.env.TRAINING_AGENT_TOKEN;
const STARTUP_TIME = new Date().toISOString();

// Permissive CORS: this is a sandbox training agent meant to be
// called from any origin (certification UI, notebooks, CLI tools, etc.)
function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!TRAINING_AGENT_TOKEN) {
    // No token configured = dev mode, allow all
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), TRAINING_AGENT_TOKEN)) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Invalid or missing bearer token' },
    });
    return;
  }
  next();
}

function getBaseUrl(req: Request): string {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

export function createTrainingAgentRouter(): Router {
  const router = Router();

  // Start session cleanup
  startSessionCleanup();

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', service: 'training-agent' });
  });

  // adagents.json discovery
  router.get('/.well-known/adagents.json', (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    const agentUrl = `${baseUrl}/api/training-agent`;

    res.json({
      $schema: '/schemas/adagents.json',
      contact: {
        name: 'AdCP Training Agent',
        url: 'https://adcontextprotocol.org',
      },
      authorized_agents: [{
        url: `${agentUrl}/mcp`,
        authorized_for: 'AdCP training, testing, and certification (sandbox)',
        authorization_type: 'inline_properties',
        properties: PUBLISHERS.flatMap(pub =>
          pub.properties.map(prop => ({
            identifier_type: prop.identifierType,
            identifier_value: prop.identifierValue,
            name: prop.name,
            supported_channels: prop.channels,
            tags: prop.tags,
          })),
        ),
      }],
      last_updated: STARTUP_TIME,
    });
  });

  // CORS preflight
  router.options('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  // MCP endpoint
  router.post('/mcp', requireToken, async (req: Request, res: Response) => {
    setCORSHeaders(res);

    let server: ReturnType<typeof createTrainingAgentServer> | null = null;
    try {
      // Build training context (open mode for now; training mode in Stage 2)
      const ctx: TrainingContext = { mode: 'open' };

      server = createTrainingAgentServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless
      });

      await server.connect(transport);

      logger.debug({ method: req.body?.method, ip: req.ip }, 'Training agent: handling request');

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ error }, 'Training agent: request error');
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

  // GET/DELETE not supported in stateless mode
  router.get('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });

  logger.info('Training agent routes configured');
  return router;
}
