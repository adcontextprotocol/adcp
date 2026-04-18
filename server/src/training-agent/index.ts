/**
 * Training agent route setup.
 *
 * Mounts the MCP endpoint at /api/training-agent/mcp with simple
 * bearer token auth, CORS, and adagents.json discovery.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { WorkOS } from '@workos-inc/node';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createLogger } from '../logger.js';
import { createTrainingAgentServer } from './task-handlers.js';
import { startSessionCleanup } from './state.js';
import { PUBLISHERS } from './publishers.js';
import { SIGNAL_PROVIDERS } from './signal-providers.js';
import { isWorkOSApiKeyFormat } from '../middleware/api-key-format.js';
import { PUBLIC_TEST_AGENT } from '../config/test-agent.js';
import { TRAINING_AGENT_HOSTNAME } from './config.js';
import { createOAuthProvider, MCP_AUTH_ENABLED } from '../mcp/oauth-provider.js';
import type { TrainingContext } from './types.js';

const logger = createLogger('training-agent-routes');

const TRAINING_AGENT_TOKEN = process.env.TRAINING_AGENT_TOKEN;
const PUBLIC_TEST_AGENT_TOKEN = process.env.PUBLIC_TEST_AGENT_TOKEN || PUBLIC_TEST_AGENT.token;
const STARTUP_TIME = new Date().toISOString();

// WorkOS client for API key validation (reuses main app's credentials)
const workos = process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
  ? new WorkOS(process.env.WORKOS_API_KEY, { clientId: process.env.WORKOS_CLIENT_ID })
  : null;

// OAuth resource metadata — advertised at .well-known and referenced in
// WWW-Authenticate challenges so clients can discover the AAO auth server.
const OAUTH_RESOURCE = `https://${TRAINING_AGENT_HOSTNAME}/mcp`;
const OAUTH_METADATA_URL = `https://${TRAINING_AGENT_HOSTNAME}/.well-known/oauth-protected-resource/mcp`;
const OAUTH_AUTHORIZATION_SERVER = (process.env.BASE_URL || 'https://agenticadvertising.org').replace(/\/$/, '') + '/';
const WWW_AUTH_CHALLENGE = `Bearer realm="test-agent", resource_metadata="${OAUTH_METADATA_URL}"`;

// OAuth JWT validator — lazily constructed to avoid WorkOS JWKS setup cost
// when MCP auth is disabled (e.g. local dev with MCP_AUTH_DISABLED=true).
let oauthMiddleware: ReturnType<typeof requireBearerAuth> | null = null;
function getOAuthMiddleware(): ReturnType<typeof requireBearerAuth> | null {
  if (!MCP_AUTH_ENABLED) return null;
  if (!oauthMiddleware) {
    oauthMiddleware = requireBearerAuth({
      verifier: createOAuthProvider(),
      resourceMetadataUrl: OAUTH_METADATA_URL,
    });
  }
  return oauthMiddleware;
}

// Permissive CORS: this is a sandbox training agent meant to be
// called from any origin (certification UI, notebooks, CLI tools, etc.).
// WWW-Authenticate is exposed so browser-based MCP clients can read the
// OAuth challenge on 401 responses and discover the auth server.
function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, WWW-Authenticate');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const UNAUTHORIZED_MESSAGE = 'Invalid or missing bearer token. Use an AAO API key (from your dashboard), a static test token, or an AAO OAuth access token.';

function sendUnauthorized(res: Response, message: string = UNAUTHORIZED_MESSAGE): void {
  res.setHeader('WWW-Authenticate', WWW_AUTH_CHALLENGE);
  res.status(401).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message },
  });
}

async function requireToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!TRAINING_AGENT_TOKEN && !PUBLIC_TEST_AGENT_TOKEN && !workos && !MCP_AUTH_ENABLED) {
    // No tokens configured and no WorkOS = dev mode, allow all
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    sendUnauthorized(res);
    return;
  }
  const token = auth.slice(7);

  // Accept static tokens (primary or public test agent)
  if ((TRAINING_AGENT_TOKEN && constantTimeEqual(token, TRAINING_AGENT_TOKEN)) ||
      (PUBLIC_TEST_AGENT_TOKEN && constantTimeEqual(token, PUBLIC_TEST_AGENT_TOKEN))) {
    return next();
  }

  // Accept WorkOS API keys (AAO dashboard API keys with sk_ or wos_api_key_ prefix)
  if (workos && isWorkOSApiKeyFormat(token)) {
    try {
      const result = await workos.apiKeys.validateApiKey({ value: token });
      if (result.apiKey) {
        logger.info({ orgId: result.apiKey.owner.id }, 'Training agent: authenticated via AAO API key');
        return next();
      }
      sendUnauthorized(res, 'Invalid API key. Generate a new key from your AAO dashboard.');
    } catch (err) {
      logger.warn({ err }, 'Training agent: WorkOS API key validation failed');
      sendUnauthorized(res, 'API key validation failed. Please try again.');
    }
    return;
  }

  // Accept AAO OAuth access tokens (WorkOS-issued JWTs). The MCP SDK's
  // requireBearerAuth handles signature/expiry/scope validation, sets
  // req.auth on success, and emits a proper RFC 6750 WWW-Authenticate on 401.
  const oauthMw = getOAuthMiddleware();
  if (oauthMw) {
    await oauthMw(req, res, next);
    return;
  }

  sendUnauthorized(res);
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

  // Apply CORS to every response on this router so 401s include the headers
  // browser-based MCP clients need to read the WWW-Authenticate challenge.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    setCORSHeaders(res);
    next();
  });

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', service: 'training-agent' });
  });

  // OAuth 2.0 Protected Resource Metadata (RFC 9728) — advertises this host's
  // own resource URL and the AAO authorization server. Mounted on the training
  // agent router so host-based routing delivers it for test-agent.adcontextprotocol.org
  // before the main app's mcpAuthRouter (which advertises a different resource).
  router.get('/.well-known/oauth-protected-resource/mcp', (_req: Request, res: Response) => {
    res.json({
      resource: OAUTH_RESOURCE,
      authorization_servers: [OAUTH_AUTHORIZATION_SERVER],
      scopes_supported: ['openid', 'profile', 'email'],
    });
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
    res.status(204).end();
  });

  // Rate limiting: 1500 requests/minute per caller (in-memory, no DB dependency).
  // The training agent is a sandbox — bulk storyboard evaluation runs 3-4 MCP
  // calls per step across 27 storyboards (~600+ calls within a short window).
  //
  // Keyed on the authenticated subject when available (OAuth user/client, API key owner)
  // so a single authenticated caller can't dodge the cap by rotating IPs. Falls back to
  // IP for unauthenticated requests (which would have been rejected by requireToken
  // upstream, but the safety net matters if auth is ever disabled for local dev).
  const mcpRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1500,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, ip: false },
    keyGenerator: (req: Request) => {
      const authInfo = (req as Request & { auth?: AuthInfo }).auth;
      const sub = authInfo?.extra?.sub;
      if (typeof sub === 'string' && sub) return `user:${sub}`;
      if (authInfo?.clientId) return `client:${authInfo.clientId}`;
      return `ip:${ipKeyGenerator(req.ip || '')}`;
    },
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Rate limit exceeded. Please try again later.' },
      });
    },
  });

  // MCP endpoint
  router.post('/mcp', requireToken, mcpRateLimiter, async (req: Request, res: Response) => {

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
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });

  // --- Legacy SSE transport ---
  // Some MCP clients (e.g. older SDKs) only support the deprecated SSE transport.
  // GET /sse establishes the event stream; POST /message delivers JSON-RPC messages.
  // Rate limiter is shared with /mcp — SSE uses 2 requests per interaction (GET + POST).
  const sseSessions = new Map<string, SSEServerTransport>();
  const sseSessionLastSeen = new Map<string, number>();
  const SSE_MAX_SESSIONS = 200;
  const SSE_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  // Sweep stale sessions that didn't trigger a close event (e.g. LB timeout)
  const sseSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of sseSessionLastSeen) {
      if (now - ts > SSE_SESSION_TTL_MS) {
        const transport = sseSessions.get(id);
        if (transport) transport.close().catch(() => {});
        sseSessions.delete(id);
        sseSessionLastSeen.delete(id);
      }
    }
  }, 5 * 60 * 1000);
  if (sseSweepTimer.unref) sseSweepTimer.unref();

  router.options('/sse', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.options('/message', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.get('/sse', requireToken, mcpRateLimiter, async (req: Request, res: Response) => {

    if (sseSessions.size >= SSE_MAX_SESSIONS) {
      res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Too many active SSE sessions. Please try again later.' },
      });
      return;
    }

    let server: ReturnType<typeof createTrainingAgentServer> | null = null;
    try {
      const ctx: TrainingContext = { mode: 'open' };
      server = createTrainingAgentServer(ctx);

      // The endpoint path is relative to the router mount point
      const transport = new SSEServerTransport(`${req.baseUrl}/message`, res);
      const sessionId = transport.sessionId;
      sseSessions.set(sessionId, transport);
      sseSessionLastSeen.set(sessionId, Date.now());

      transport.onclose = () => {
        sseSessions.delete(sessionId);
        sseSessionLastSeen.delete(sessionId);
        server?.close().catch(() => {});
        logger.debug({ sessionId }, 'SSE session closed');
      };

      await server.connect(transport);

      logger.debug({ sessionId, ip: req.ip }, 'SSE session established');
    } catch (error) {
      logger.error({ error }, 'Training agent: SSE connection error');
      await server?.close().catch(() => {});
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal server error' },
        });
      }
    }
  });

  router.post('/message', requireToken, mcpRateLimiter, async (req: Request, res: Response) => {

    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Missing sessionId query parameter' },
      });
      return;
    }

    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(404).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'SSE session not found or expired' },
      });
      return;
    }

    sseSessionLastSeen.set(sessionId, Date.now());

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      logger.error({ error, sessionId }, 'Training agent: SSE message error');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal server error' },
        });
      }
    }
  });

  logger.info('Training agent routes configured');
  return router;
}
