/**
 * Training agent route setup — multi-tenant.
 *
 * Mounts six per-specialism tenants under `/api/training-agent/`:
 *   /sales, /signals, /governance, /creative, /creative-builder, /brand
 *
 * Each tenant exposes its own MCP endpoint (`/<tenant>/mcp`) with bearer
 * auth + rate limiting. Health, JWKS, and adagents.json discovery live
 * at the parent prefix.
 *
 * Replaces the legacy single-URL `/mcp` and `/mcp-strict` routes (the
 * latter was a request-signing-required variant). Production agents are
 * registered per-tenant in AAO; storyboards target the per-tenant URL.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { WorkOS } from '@workos-inc/node';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  anyOf,
  verifyApiKey,
  extractBearerToken,
  respondUnauthorized,
  requireSignatureWhenPresent,
  signatureErrorCodeFromCause,
  AuthError,
  type Authenticator,
  type AuthPrincipal,
} from '@adcp/sdk/server';
import { createLogger } from '../logger.js';
import { mountTenantRoutes } from './tenants/router.js';
import { createTrainingAgentServer } from './task-handlers.js';
import { runWithSessionContext, flushDirtySessions, startSessionCleanup } from './state.js';
import type { TrainingContext } from './types.js';
import { PUBLISHERS } from './publishers.js';
import { SIGNAL_PROVIDERS } from './signal-providers.js';
import { getPublicJwks } from './webhooks.js';
import { buildRequestSigningAuthenticator } from './request-signing.js';
import { isWorkOSApiKeyFormat } from '../middleware/api-key-format.js';
import { PUBLIC_TEST_AGENT } from '../config/test-agent.js';

const logger = createLogger('training-agent-routes');

const TRAINING_AGENT_TOKEN = process.env.TRAINING_AGENT_TOKEN;
const PUBLIC_TEST_AGENT_TOKEN = process.env.PUBLIC_TEST_AGENT_TOKEN || PUBLIC_TEST_AGENT.token;
const STARTUP_TIME = new Date().toISOString();

// WorkOS client for API key validation (reuses main app's credentials)
const workos = process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
  ? new WorkOS(process.env.WORKOS_API_KEY, { clientId: process.env.WORKOS_CLIENT_ID })
  : null;

/**
 * Security posture: the training agent is a public sandbox. Any valid AAO
 * dashboard API key authenticates — there is no org allowlist, no plan-tier
 * gate, no per-org quota check. Account-level isolation is provided
 * downstream via `scopedPrincipal` (idempotency is partitioned by
 * authPrincipal ⨯ account scope) and session state is keyed by
 * brand.domain / account_id. Training-agent data is non-sensitive by design.
 */
// Conformance handle documented in every test-kit header
// (static/compliance/source/test-kits/*.yaml, auth.api_key comment): agents
// SHOULD accept any Bearer matching `demo-<kit>-v<n>` so the suffix can rotate
// across spec versions without breaking previously-conformant agents.
const DEMO_TEST_KIT_KEY_PATTERN = /^demo-[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/;

function buildBearerAuthenticator(): Authenticator | null {
  if (!TRAINING_AGENT_TOKEN && !PUBLIC_TEST_AGENT_TOKEN && !workos) {
    return null; // dev mode: open
  }
  const staticKeys: Record<string, AuthPrincipal> = {};
  if (TRAINING_AGENT_TOKEN) staticKeys[TRAINING_AGENT_TOKEN] = { principal: 'static:primary' };
  if (PUBLIC_TEST_AGENT_TOKEN) staticKeys[PUBLIC_TEST_AGENT_TOKEN] = { principal: 'static:public' };

  const authenticators: Authenticator[] = [];
  if (Object.keys(staticKeys).length > 0) {
    authenticators.push(verifyApiKey({ keys: staticKeys }));
  }
  authenticators.push(verifyApiKey({
    verify: (token) => {
      if (!DEMO_TEST_KIT_KEY_PATTERN.test(token)) return null;
      return { principal: `static:demo:${token}` };
    },
  }));
  if (workos) {
    const workosClient = workos;
    authenticators.push(verifyApiKey({
      verify: async (token) => {
        if (!isWorkOSApiKeyFormat(token)) return null;
        const result = await workosClient.apiKeys.createValidation({ value: token });
        if (!result.apiKey) return null;
        const orgId = result.apiKey.owner.id;
        logger.info({ orgId }, 'Training agent: authenticated via AAO API key');
        return { principal: `workos:${orgId}` };
      },
    }));
  }
  if (authenticators.length === 0) return null;
  return authenticators.length === 1 ? authenticators[0] : anyOf(...authenticators);
}

// Lazy so the signing authenticator builds on first auth call —
// avoids reading the compliance test JWKS at module import time, which
// would break test setups that mock the compliance cache.
let _signingAuth: Authenticator | null = null;
function lazySigningAuth(): Authenticator {
  return (req) => {
    if (!_signingAuth) _signingAuth = buildRequestSigningAuthenticator();
    return _signingAuth(req);
  };
}

/**
 * Tenant-route authenticator: presence-gated signature composition.
 * Callers with no `Signature-Input` header fall through to bearer auth.
 * Callers that DO present a signature header MUST produce a valid one.
 */
function buildDefaultAuthenticator(): Authenticator | null {
  const bearerAuth = buildBearerAuthenticator();
  if (!bearerAuth) return null;
  return requireSignatureWhenPresent(lazySigningAuth(), bearerAuth);
}

const defaultAuthenticator = buildDefaultAuthenticator();

function buildRequireToken(authenticator: Authenticator | null) {
  return async function requireToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!authenticator) {
      // No tokens configured = dev mode, allow all
      res.locals.trainingPrincipal = 'anonymous';
      return next();
    }
    let principal: AuthPrincipal | null;
    try {
      principal = await authenticator(req);
    } catch (err) {
      logger.warn({ err }, 'Training agent: authentication error');
      const signatureError = signatureErrorCodeFromCause(err);
      if (signatureError) {
        respondUnauthorized(req, res, {
          signatureError,
          errorDescription: err instanceof AuthError ? err.publicMessage : 'Signature rejected.',
        });
        return;
      }
      const publicMessage = err instanceof AuthError ? err.publicMessage : 'Authentication failed';
      respondUnauthorized(req, res, { error: 'invalid_token', errorDescription: publicMessage });
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
  };
}

const requireTokenDefault = buildRequireToken(defaultAuthenticator);

function getBaseUrl(req: Request): string {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

const TENANT_IDS = ['signals', 'sales', 'governance', 'creative', 'creative-builder', 'brand'] as const;

export function createTrainingAgentRouter(): Router {
  const router = Router();

  startSessionCleanup();

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

  // Per-tenant MCP routes — each tenant gets POST /<tenant>/mcp with bearer
  // auth + rate limiting. The tenant registry handles dispatch via
  // resolveByRequest(host, pathname).
  mountTenantRoutes(router, TENANT_IDS, {
    rateLimit: mcpRateLimiter,
    requireAuth: requireTokenDefault,
  });

  // Legacy single-URL `/mcp` route — preserved as a back-compat alias for
  // existing AAO entries, Sage/Addie configs, docs, and external storyboard
  // runners that target `test-agent.adcontextprotocol.org/mcp`. Serves the
  // v5 monolith (`createTrainingAgentServer`) so it advertises every tool
  // on one URL, the way it always has. Per-tenant URLs are the migration
  // target; this mount goes away once the references are cut over.
  function setLegacyCORS(res: Response): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  }

  async function legacyMcpHandler(req: Request, res: Response): Promise<void> {
    setLegacyCORS(res);
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</.well-known/adagents.json>; rel="successor-version"');
    let server: ReturnType<typeof createTrainingAgentServer> | null = null;
    try {
      const principal = (res.locals.trainingPrincipal as string | undefined) ?? 'anonymous';
      const ctx: TrainingContext = { mode: 'open', principal };
      server = createTrainingAgentServer(ctx);

      // Streamable HTTP transport requires both `application/json` and
      // `text/event-stream` in Accept; storyboard probes only send the
      // former. Add the missing one + propagate to rawHeaders so the
      // transport's Fetch wrapper sees it.
      const acceptHeader = req.headers.accept;
      const hasJson = typeof acceptHeader === 'string' && acceptHeader.includes('application/json');
      const hasSse = typeof acceptHeader === 'string' && acceptHeader.includes('text/event-stream');
      if (hasJson && !hasSse) {
        const rewritten = `${acceptHeader}, text/event-stream`;
        req.headers.accept = rewritten;
        const raw = (req as unknown as { rawHeaders?: string[] }).rawHeaders;
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i += 2) {
            if (raw[i].toLowerCase() === 'accept') raw[i + 1] = rewritten;
          }
        }
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      logger.debug({ method: req.body?.method, route: 'legacy /mcp' }, 'Training agent: legacy request');
      await runWithSessionContext(async () => {
        await transport.handleRequest(req, res, req.body);
        await flushDirtySessions();
      });
    } catch (error) {
      logger.error({ error, route: 'legacy /mcp' }, 'Training agent: legacy request error');
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

  router.options('/mcp', (_req: Request, res: Response) => {
    setLegacyCORS(res);
    res.status(204).end();
  });
  router.post('/mcp', mcpRateLimiter, requireTokenDefault, legacyMcpHandler);
  router.get('/mcp', (_req: Request, res: Response) => {
    setLegacyCORS(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });

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

  // adagents.json discovery — lists each per-tenant URL with the
  // properties / signals it serves. Per-tenant entries replace the
  // single-URL `authorized_agents[0].url` from the v5 monolith.
  router.get('/.well-known/adagents.json', (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    const agentUrl = `${baseUrl}${req.baseUrl}`;

    res.json({
      $schema: '/schemas/adagents.json',
      contact: {
        name: 'AdCP Training Agent',
        url: 'https://adcontextprotocol.org',
      },
      authorized_agents: [
        {
          url: `${agentUrl}/sales/mcp`,
          authorized_for: 'AdCP training — sales (programmatic + guaranteed)',
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
        },
        {
          url: `${agentUrl}/signals/mcp`,
          authorized_for: 'AdCP training — signals (marketplace + owned)',
          authorization_type: 'inline_properties',
          properties: [],
        },
      ],
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

  logger.info({ tenants: TENANT_IDS }, 'Training agent routes configured');
  return router;
}
