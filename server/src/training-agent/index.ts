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
  requireAuthenticatedOrSigned,
  signatureErrorCodeFromCause,
  AuthError,
  type Authenticator,
  type AuthPrincipal,
} from '@adcp/client/server';
import { createLogger } from '../logger.js';
import { createTrainingAgentServer } from './task-handlers.js';
import { createFrameworkTrainingAgentServer, useFrameworkServer } from './framework-server.js';
import { redactConflictEnvelopeInBody } from './conflict-envelope.js';
import { startSessionCleanup } from './state.js';
import { PUBLISHERS } from './publishers.js';
import { SIGNAL_PROVIDERS } from './signal-providers.js';
import { getPublicJwks } from './webhooks.js';
import { buildRequestSigningAuthenticator, STRICT_REQUIRED_FOR } from './request-signing.js';
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
  if (workos) {
    const workosClient = workos; // narrow for closure
    authenticators.push(verifyApiKey({
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
  if (authenticators.length === 0) return null;
  return authenticators.length === 1 ? authenticators[0] : anyOf(...authenticators);
}

// Wrapped so the signing authenticator is lazily built on first auth call —
// avoids reading the compliance test JWKS at module import time, which would
// break test setups that mock the compliance cache.
let _signingAuth: Authenticator | null = null;
function lazySigningAuth(): Authenticator {
  return (req) => {
    if (!_signingAuth) _signingAuth = buildRequestSigningAuthenticator();
    return _signingAuth(req);
  };
}

/**
 * Default `/mcp` route: bearer OR valid signature. Unsigned bearer callers
 * pass through verifyApiKey; signed requests compose via anyOf. Present-but-
 * invalid signatures fall through to bearer (a known gap — closed on the
 * strict route, tracked upstream as adcp-client#659).
 */
function buildDefaultAuthenticator(): Authenticator | null {
  const bearerAuth = buildBearerAuthenticator();
  if (!bearerAuth) return null;
  return anyOf(bearerAuth, lazySigningAuth());
}

/**
 * Strict `/mcp-strict` route (grader target): presence-gated signature
 * with `required_for: ['create_media_buy']`. Delegates to the SDK's
 * `requireAuthenticatedOrSigned` (5.7) — presence-gated signing, bypass
 * on valid bearer, `request_signature_required` thrown as an
 * `AuthError(cause: RequestSignatureError)` when the op requires signing
 * and no other credential verifies. `serve()` / the handler below auto-
 * detect the signature-layer error via `signatureErrorCodeFromCause`.
 */
function buildStrictAuthenticator(): Authenticator | null {
  const bearerAuth = buildBearerAuthenticator();
  if (!bearerAuth) return null;
  return requireAuthenticatedOrSigned({
    signature: lazySigningAuth(),
    fallback: bearerAuth,
    requiredFor: STRICT_REQUIRED_FOR,
    resolveOperation: (req) => {
      const raw = (req as { rawBody?: string }).rawBody;
      if (!raw) return undefined;
      try {
        const body = JSON.parse(raw) as { method?: string; params?: { name?: string } };
        if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
          return body.params.name;
        }
      } catch {
        // Transport rejects malformed JSON downstream.
      }
      return undefined;
    },
  });
}

const defaultAuthenticator = buildDefaultAuthenticator();
const strictAuthenticator = buildStrictAuthenticator();

function buildRequireToken(authenticator: Authenticator | null) {
  return async function requireToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!authenticator) {
      // No tokens configured and no WorkOS = dev mode, allow all
      res.locals.trainingPrincipal = 'anonymous';
      return next();
    }
    let principal: AuthPrincipal | null;
    try {
      principal = await authenticator(req);
    } catch (err) {
      logger.warn({ err }, 'Training agent: authentication error');
      // `signatureErrorCodeFromCause` (5.7) unwraps `AuthError` → cause to
      // surface RFC 9421 error codes. `respondUnauthorized({ signatureError })`
      // emits `WWW-Authenticate: Signature error="<code>"` — the challenge
      // the `signed_requests` conformance grader reads the code off of.
      const signatureError = signatureErrorCodeFromCause(err);
      if (signatureError) {
        respondUnauthorized(req, res, {
          signatureError,
          errorDescription: err instanceof AuthError ? err.publicMessage : 'Signature rejected.',
        });
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
  };
}

const requireTokenDefault = buildRequireToken(defaultAuthenticator);
const requireTokenStrict = buildRequireToken(strictAuthenticator);

/**
 * Capture the response body as it's written by the MCP transport, redact any
 * `IDEMPOTENCY_CONFLICT` envelopes (framework-dispatch's `adcpError()` emits
 * `recovery` which the storyboard invariant treats as a payload leak), and
 * flush the transformed body through the original writer. Idempotent: safe
 * to call even when no conflict envelope is present (pass-through via a
 * fast-path `includes('IDEMPOTENCY_CONFLICT')` probe inside the redactor).
 *
 * Works for the JSON-response mode (`enableJsonResponse: true`) the training
 * agent forces for every request — the transport writes a single
 * `res.write(body) ; res.end()` pair, which this wrapper buffers into one
 * string before rewriting. Streaming/SSE would break this contract, so do
 * not remove `enableJsonResponse: true` from the transport config above.
 */
function wrapResponseForConflictRedaction(res: Response): void {
  const origWriteHead = res.writeHead.bind(res);
  const origWrite = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const origEnd = res.end.bind(res) as (chunk?: unknown, ...rest: unknown[]) => Response;
  const chunks: Buffer[] = [];
  let pendingHead: { status: number; headers: Record<string, string | number | string[]> } | null = null;

  const collect = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null) return;
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, 'utf8'));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else chunks.push(Buffer.from(String(chunk), 'utf8'));
  };

  // `@hono/node-server` flushes headers via `writeHead(status, headers)`
  // before calling `write` — with content-length already computed from the
  // original body length. Buffering headers here defers flush until `end`
  // runs, so the final `Content-Length` reflects the redacted body size.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).writeHead = ((
    status: number,
    statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
    headersArg?: Record<string, string | number | string[]>,
  ): Response => {
    const headers = typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null
      ? statusMessageOrHeaders
      : headersArg ?? {};
    pendingHead = { status, headers: { ...headers } };
    return res;
  }) as typeof res.writeHead;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).write = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    collect(chunk);
    const callback = typeof encoding === 'function' ? encoding : cb;
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = (chunk?: unknown, encoding?: unknown, cb?: unknown): Response => {
    if (chunk !== undefined && typeof chunk !== 'function') collect(chunk);
    const callback = typeof chunk === 'function'
      ? chunk
      : typeof encoding === 'function'
        ? encoding
        : cb;
    const body = Buffer.concat(chunks).toString('utf8');
    const rewritten = redactConflictEnvelopeInBody(body);
    if (pendingHead) {
      // Hono's node-server path: the transport called `writeHead(status, headers)`
      // up front. Patch content-length (case-insensitive) to the redacted
      // length before flushing so the wire byte count matches the body.
      const headers = pendingHead.headers;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-length') delete headers[key];
      }
      headers['content-length'] = Buffer.byteLength(rewritten, 'utf8');
      origWriteHead(pendingHead.status, headers);
      pendingHead = null;
    }
    // When `pendingHead` is null, either no response was produced (e.g. an
    // uncaught throw before the transport wrote anything) or Express's own
    // error-path `.json()` handler flushed via `setHeader`+`end` rather than
    // `writeHead`. Node's implicit-header emission fires on the first
    // `origWrite`/`origEnd` in that case, using whatever headers Express
    // already stacked via `setHeader`. Content-Length may be wrong if the
    // error path pre-set it, but those responses never carry an
    // IDEMPOTENCY_CONFLICT body so `rewritten === body` and the length is
    // unchanged.
    if (rewritten.length > 0) origWrite(rewritten);
    const args: unknown[] = [];
    if (typeof callback === 'function') args.push(callback);
    return origEnd(...args);
  };
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

  // MCP endpoint factory. Two routes share the same body:
  //   /mcp — sandbox. anyOf(bearers, signing). required_for=[].
  //   /mcp-strict — grader target. presence-gated signing. required_for=['create_media_buy'].
  // The `strict` flag flows into TrainingContext so get_adcp_capabilities
  // advertises the correct request_signing block per route.
  function mcpHandler(strict: boolean) {
    return async (req: Request, res: Response) => {
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
        const ctx: TrainingContext = { mode: 'open', principal, strict };

        server = useFrameworkServer()
          ? createFrameworkTrainingAgentServer(ctx)
          : createTrainingAgentServer(ctx);

        // MCP Streamable HTTP transport requires the client Accept header to
        // list BOTH `application/json` and `text/event-stream` per the 2025-03-26
        // spec — or it returns 406 Not Acceptable. Storyboard conformance
        // probes (SDK `rawMcpProbe`) and other strict JSON consumers only
        // send `application/json`. We satisfy both by (a) adding the missing
        // SSE content type so the transport's check passes and (b) enabling
        // JSON response mode so the body is single-shot JSON rather than an
        // SSE stream the probe can't parse.
        //
        // Bearer-authed buyer agents using @adcp/client already send both
        // content types, so this is additive — no regression on the hot
        // path. `enableJsonResponse` changes the response format for every
        // request, not just JSON-only probes; the @adcp/client unwrapper
        // handles both equivalently (`isMCPResponse` check looks for
        // structuredContent/content keys, not Content-Type).
        const acceptHeader = req.headers.accept;
        const hasJson = typeof acceptHeader === 'string' && acceptHeader.includes('application/json');
        const hasSse = typeof acceptHeader === 'string' && acceptHeader.includes('text/event-stream');
        if (hasJson && !hasSse) {
          const rewritten = `${acceptHeader}, text/event-stream`;
          req.headers.accept = rewritten;
          // @hono/node-server (used internally by StreamableHTTPServerTransport)
          // reads headers from `rawHeaders` — the alternating [name, value] array
          // Node's HTTP parser fills in. Mutating `req.headers.accept` alone
          // doesn't propagate to the transport's Fetch Request wrapper.
          const raw = (req as unknown as { rawHeaders?: string[] }).rawHeaders;
          if (Array.isArray(raw)) {
            for (let i = 0; i < raw.length; i += 2) {
              if (raw[i].toLowerCase() === 'accept') {
                raw[i + 1] = rewritten;
              }
            }
          }
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless
          enableJsonResponse: true,
        });

        await server.connect(transport);

        // Framework-dispatch IDEMPOTENCY_CONFLICT envelopes route through
        // `@adcp/client/server`'s `adcpError()` builder, which auto-injects
        // `recovery` on every error. The universal idempotency storyboard's
        // `conflict_no_payload_leak` invariant allows only a narrow set of
        // envelope keys on conflict — anything else is flagged as a potential
        // stolen-key read oracle. Intercept the response bytes before they
        // leave the process and strip disallowed keys. Legacy dispatch builds
        // a minimal envelope by hand, so the wrap is a no-op there in
        // practice (it still runs but finds nothing to redact).
        wrapResponseForConflictRedaction(res);

        logger.debug({ method: req.body?.method, ip: req.ip, strict }, 'Training agent: handling request');

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error({ error, strict }, 'Training agent: request error');
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
    };
  }

  router.post('/mcp', mcpRateLimiter, requireTokenDefault, mcpHandler(false));

  // Strict endpoint for `adcp grade request-signing` and the AAO Verified
  // compliance dashboard. Enforces `required_for: ['create_media_buy']` with
  // presence-gated auth so vector 001 (`request_signature_required`) fires
  // instead of being swallowed by the bearer fallthrough on /mcp.
  router.options('/mcp-strict', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });
  router.post('/mcp-strict', mcpRateLimiter, requireTokenStrict, mcpHandler(true));
  router.get('/mcp-strict', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
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

  router.get('/sse', mcpRateLimiter, requireTokenDefault, async (req: Request, res: Response) => {
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

  router.post('/message', mcpRateLimiter, requireTokenDefault, async (req: Request, res: Response) => {
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
