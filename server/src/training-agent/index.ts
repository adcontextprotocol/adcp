/**
 * Training agent route setup.
 *
 * Mounts the MCP endpoint at /api/training-agent/mcp with simple
 * bearer token auth, CORS, and adagents.json discovery.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from '../logger.js';
import { createTrainingAgentServer } from './task-handlers.js';
import { startSessionCleanup } from './state.js';
import { PUBLISHERS } from './publishers.js';
import { SIGNAL_PROVIDERS } from './signal-providers.js';
import type { TrainingContext } from './types.js';

const logger = createLogger('training-agent-routes');

const TRAINING_AGENT_TOKEN = process.env.TRAINING_AGENT_TOKEN;
const PUBLIC_TEST_AGENT_TOKEN = process.env.PUBLIC_TEST_AGENT_TOKEN || '1v8tAhASaUYYp' + '4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ';
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
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!TRAINING_AGENT_TOKEN && !PUBLIC_TEST_AGENT_TOKEN) {
    // No tokens configured = dev mode, allow all
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Invalid or missing bearer token' },
    });
    return;
  }
  const token = auth.slice(7);
  // Accept primary token or the documented public test agent token
  if ((TRAINING_AGENT_TOKEN && constantTimeEqual(token, TRAINING_AGENT_TOKEN)) ||
      (PUBLIC_TEST_AGENT_TOKEN && constantTimeEqual(token, PUBLIC_TEST_AGENT_TOKEN))) {
    return next();
  }
  res.status(401).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Invalid or missing bearer token' },
  });
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
    // req.baseUrl is the mount path (e.g. '/api/training-agent') — empty when
    // served via host-based routing at root
    const agentUrl = `${baseUrl}${req.baseUrl}`;

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
      signals: SIGNAL_PROVIDERS.flatMap(provider =>
        provider.signals.map(signal => ({
          id: signal.signalAgentSegmentId,
          name: signal.name,
          description: signal.description,
          value_type: signal.valueType,
          tags: signal.tags,
          ...(signal.categories && { allowed_values: signal.categories }),
          ...(signal.range && { range: signal.range }),
        })),
      ),
      signal_tags: {
        automotive: { name: 'Automotive signals', description: 'Vehicle ownership, purchase intent, and service signals' },
        geo: { name: 'Geographic signals', description: 'Location, mobility, and foot traffic signals' },
        retail: { name: 'Retail signals', description: 'Purchase behavior, loyalty, and shopping signals' },
        demographic: { name: 'Demographic signals', description: 'Income, life stage, and household signals' },
        identity: { name: 'Identity signals', description: 'Cross-device and household identity signals' },
        contextual: { name: 'Contextual signals', description: 'Content category, sentiment, and page-level signals' },
        first_party: { name: 'First-party signals', description: 'Publisher subscriber and CDP audience signals' },
      },
      last_updated: STARTUP_TIME,
    });
  });

  // CORS preflight
  router.options('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  // Rate limiting: 60 requests/minute per IP (in-memory, no DB dependency)
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
