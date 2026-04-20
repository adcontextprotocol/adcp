/**
 * Training agent route setup.
 *
 * Mounts the MCP endpoint at /api/training-agent/mcp with simple
 * bearer token auth, CORS, and adagents.json discovery.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { WorkOS } from '@workos-inc/node';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  anyOf,
  verifyApiKey,
  extractBearerToken,
  respondUnauthorized,
  requireSignatureWhenPresent,
  AuthError,
  type Authenticator,
  type AuthPrincipal,
} from '@adcp/client/server';
import { RequestSignatureError } from '@adcp/client/signing';
import { createLogger } from '../logger.js';
import { createTrainingAgentServer } from './task-handlers.js';
import { createFrameworkTrainingAgentServer, useFrameworkServer } from './framework-server.js';
import { startSessionCleanup } from './state.js';
import { PUBLISHERS } from './publishers.js';
import { SIGNAL_PROVIDERS } from './signal-providers.js';
import { getPublicJwks } from './webhooks.js';
import { buildRequestSigningAuthenticator } from './request-signing.js';
import { isWorkOSApiKeyFormat } from '../middleware/api-key-format.js';
import { PUBLIC_TEST_AGENT } from '../config/test-agent.js';
import type { TrainingContext } from './types.js';

const logger = createLogger('training-agent-routes');

const TRAINING_AGENT_TOKEN = process.env.TRAINING_AGENT_TOKEN;
const PUBLIC_TEST_AGENT_TOKEN = process.env.PUBLIC_TEST_AGENT_TOKEN || PUBLIC_TEST_AGENT.token;
const STARTUP_TIME = new Date().toISOString();

// WorkOS client for API key validation (reuses main app's credentials)
const workos = process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
  ? new WorkOS(process.env.WORKOS_API_KEY, { clientId: process.env.WORKOS_CLIENT_ID })
  : null;

// Permissive CORS: this is a sandbox training agent meant to be
// called from any origin (certification UI, notebooks, CLI tools, etc.)
function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
}

/**
 * Security posture: the training agent is a public sandbox. Any valid AAO
 * dashboard API key authenticates — there is no org allowlist, no plan-tier
 * gate, no per-org quota check. Account-level isolation is already provided
 * downstream via `scopedPrincipal` (idempotency is partitioned by
 * authPrincipal ⨯ account scope) and session state is keyed by
 * brand.domain / account_id. Training-agent data is non-sensitive by design.
 *
 * Do NOT reuse this authenticator for tenant-scoped surfaces. Agents that
 * need org gating should extend the `verify` callback with an allowlist
 * check (e.g., `if (!allowedOrgs.has(result.apiKey.owner.id)) return null`)
 * or layer an `anyOf` with a separate scope-aware authenticator.
 */
function buildAuthenticator(): Authenticator | null {
  if (!TRAINING_AGENT_TOKEN && !PUBLIC_TEST_AGENT_TOKEN && !workos) {
    return null; // dev mode: open
  }
  const staticKeys: Record<string, AuthPrincipal> = {};
  if (TRAINING_AGENT_TOKEN) staticKeys[TRAINING_AGENT_TOKEN] = { principal: 'static:primary' };
  if (PUBLIC_TEST_AGENT_TOKEN) staticKeys[PUBLIC_TEST_AGENT_TOKEN] = { principal: 'static:public' };

  const bearerAuths: Authenticator[] = [];
  if (Object.keys(staticKeys).length > 0) {
    bearerAuths.push(verifyApiKey({ keys: staticKeys }));
  }
  if (workos) {
    const workosClient = workos; // narrow for closure
    bearerAuths.push(verifyApiKey({
      verify: async (token) => {
        if (!isWorkOSApiKeyFormat(token)) return null;
        const result = await workosClient.apiKeys.validateApiKey({ value: token });
        if (!result.apiKey) return null;
        const orgId = result.apiKey.owner.id;
        logger.info({ orgId }, 'Training agent: authenticated via AAO API key');
        return { principal: `workos:${orgId}` };
      },
    }));
  }

  // Presence-gated composition (5.6): if the client sends a signature,
  // that signature MUST verify — we never fall through to bearer auth on
  // an invalid signature. Required for the `signed-requests` specialism,
  // whose negative conformance vectors assert rejection even when a
  // bearer token is also supplied. The SDK helper also detects a solo
  // `Signature` header (without `Signature-Input`), which a naïve
  // `if (req.headers['signature-input'])` check missed.
  const bearerChain = bearerAuths.length === 0 ? null
    : bearerAuths.length === 1 ? bearerAuths[0]
    : anyOf(...bearerAuths);
  const fallback: Authenticator = bearerChain ?? (async () => null);
  return requireSignatureWhenPresent(lazySigningAuthenticator(), fallback);
}

// Wrapped so the signing authenticator is lazily built on first auth call —
// avoids reading the compliance test JWKS at module import time, which would
// break test setups that mock the compliance cache.
let _signingAuth: Authenticator | null = null;
function lazySigningAuthenticator(): Authenticator {
  return (req) => {
    if (!_signingAuth) _signingAuth = buildRequestSigningAuthenticator();
    return _signingAuth(req);
  };
}

const authenticator = buildAuthenticator();

async function requireToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!authenticator) {
    // No tokens configured and no WorkOS = dev mode, allow all
    res.locals.trainingPrincipal = 'anonymous';
    return next();
  }
  // The SDK's authenticators read from a raw Node IncomingMessage — Express's
  // Request extends it, so we pass `req` directly.
  let principal: AuthPrincipal | null;
  try {
    principal = await authenticator(req);
  } catch (err) {
    logger.warn({ err }, 'Training agent: authentication error');
    // When a signature verification failure bubbles up from
    // `verifySignatureAsAuthenticator`, it arrives as `AuthError` with a
    // `RequestSignatureError` cause. Hand the SDK error code to
    // `respondUnauthorized` so the response carries
    // `WWW-Authenticate: Signature error="<code>"` — the shape the
    // `signed_requests` conformance vectors grade against.
    const sigCause = err instanceof AuthError && err.cause instanceof RequestSignatureError
      ? err.cause
      : null;
    if (sigCause) {
      // `respondUnauthorized` hardcodes `Bearer` as the challenge scheme.
      // Emit the Signature challenge directly so the conformance grader's
      // `WWW-Authenticate: Signature ...` extractor can read the error code.
      res.set('WWW-Authenticate', `Signature realm="mcp", error="${sigCause.code}"`);
      res.status(401).json({ error: sigCause.code, error_description: sigCause.message });
      return;
    }
    const publicMessage = err instanceof AuthError
      ? err.publicMessage
      : 'Authentication failed';
    respondUnauthorized(req, res, {
      error: 'invalid_token',
      errorDescription: publicMessage,
    });
    return;
  }
  if (!principal) {
    const hasCredentials = !!extractBearerToken(req);
    respondUnauthorized(req, res, {
      error: hasCredentials ? 'invalid_token' : 'invalid_request',
      errorDescription: hasCredentials
        ? 'Invalid bearer token. Use an AAO API key (from your dashboard) or a static test token.'
        : 'Missing bearer token. Use an AAO API key (from your dashboard) or a static test token.',
    });
    return;
  }
  res.locals.trainingPrincipal = principal.principal;
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

  // Eagerly initialize the signing authenticator so missing/corrupt
  // compliance JWKS fixtures fail loud at boot rather than as an opaque
  // 401 on the first signed request.
  if (authenticator) {
    try {
      if (!_signingAuth) _signingAuth = buildRequestSigningAuthenticator();
    } catch (err) {
      logger.fatal({ err }, 'Training agent: failed to initialise signing authenticator');
      throw err;
    }
  }

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', service: 'training-agent' });
  });

  // JWKS for webhook-signature verification by buyers (RFC 7517).
  // Public keys only — the emitter holds the private half.
  router.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(getPublicJwks());
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

  // Rate limiting: 1500 requests/minute per IP (in-memory, no DB dependency).
  // The training agent is a sandbox — bulk storyboard evaluation runs 3-4 MCP
  // calls per step across 27 storyboards (~600+ calls within a short window).
  const mcpRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1500,
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
  // Auth is composed in `buildAuthenticator`:
  //   anyOf(verifyApiKey(static), verifyApiKey(workos), verifySignatureAsAuthenticator(...))
  // Bearer-OR-signature is accepted; neither short-circuits the other.
  router.post('/mcp', mcpRateLimiter, requireToken, async (req: Request, res: Response) => {
    setCORSHeaders(res);

    // The framework returns `AdcpServer` (5.4+); the legacy factory returns
    // the SDK's `Server`. Both satisfy the transport contract at runtime
    // but have incompatible nominal types (different private fields).
    // `any` stays until the flip-default PR deletes the legacy path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let server: any = null;
    try {
      // Principal is set by requireToken; defaults to 'anonymous' in dev mode
      // when no tokens are configured.
      const principal = (res.locals.trainingPrincipal as string | undefined) ?? 'anonymous';
      const ctx: TrainingContext = { mode: 'open', principal };

      server = useFrameworkServer()
        ? createFrameworkTrainingAgentServer(ctx)
        : createTrainingAgentServer(ctx);
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
    setCORSHeaders(res);
    res.status(204).end();
  });

  router.options('/message', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  router.get('/sse', mcpRateLimiter, requireToken, async (req: Request, res: Response) => {
    setCORSHeaders(res);

    if (sseSessions.size >= SSE_MAX_SESSIONS) {
      res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Too many active SSE sessions. Please try again later.' },
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let server: any = null;
    try {
      const principal = (res.locals.trainingPrincipal as string | undefined) ?? 'anonymous';
      const ctx: TrainingContext = { mode: 'open', principal };
      server = useFrameworkServer()
        ? createFrameworkTrainingAgentServer(ctx)
        : createTrainingAgentServer(ctx);

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

  router.post('/message', mcpRateLimiter, requireToken, async (req: Request, res: Response) => {
    setCORSHeaders(res);

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
