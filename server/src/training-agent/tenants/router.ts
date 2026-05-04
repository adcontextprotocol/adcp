/**
 * Express router for path-routed multi-tenant training agent.
 *
 * Mounts:
 *   /<tenant>/mcp                   — MCP transport for the tenant
 *   /<tenant>/.well-known/brand.json — per-tenant brand discovery
 *
 * The host-level shared brand.json (listing all tenant public keys) is
 * mounted at the parent training-agent router level, not here.
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from '../../logger.js';
import { runWithSessionContext, flushDirtySessions } from '../state.js';
import { createRegistryHolder, resolveTenantHost, type RegistryHolder } from './registry.js';
import { getAggregatedPublicJwks } from './signing.js';

const logger = createLogger('training-agent-tenant-router');

function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
}

/**
 * Tenant MCP handler. The tenantId is bound at route definition (each
 * tenant gets its own Express route — `parent.post('/${tenantId}/mcp')`),
 * so dispatch resolves against the canonical host + tenant path the
 * registry was registered with — independent of the actual request URL.
 * Same code path works for host-based dispatch
 * (`test-agent.adcontextprotocol.org/sales/mcp`) and the local mount
 * (`/api/training-agent/sales/mcp`).
 */
function tenantMcpHandler(holder: RegistryHolder, tenantId: string) {
  return async (req: Request, res: Response): Promise<void> => {
    setCORSHeaders(res);

    // Bridge `res.locals.trainingPrincipal` (set by the upstream
    // `requireAuth` middleware) onto `req.auth` so the framework's MCP
    // transport surfaces it as `ctx.authInfo` to platform handlers
    // (`accounts.upsert`, `accounts.list`, etc.). Without this bridge,
    // the framework runs without auth context and per-buyer-agent
    // billing gates can't read the calling principal.
    //
    // Shape mirrors what `serve({ authenticate })` would set in
    // @adcp/sdk's serve.js — `clientId` carries the principal string,
    // `scopes` is empty (api-key path doesn't surface OAuth scopes).
    // The training-agent's bearer auth produces `static:demo:<token>`
    // / `static:primary` / `workos:<orgId>` principal shapes; downstream
    // gates dispatch on those prefixes.
    const principal = res.locals.trainingPrincipal as string | undefined;
    if (principal && !(req as { auth?: unknown }).auth) {
      // Shape mirrors @adcp/sdk@6.7.0 server/serve.js attachAuthInfo —
      // `token: ''` matches the framework's no-token path verbatim, so any
      // future shape-check that asserts field presence holds against this
      // bridged value the same as against the framework's own.
      (req as { auth: { token: string; clientId: string; scopes: string[] } }).auth = {
        token: '',
        clientId: principal,
        scopes: [],
      };
    }

    const host = resolveTenantHost(req);
    const registry = await holder.get();
    const resolved = registry.resolveByRequest(host, `/${tenantId}/mcp`);
    if (!resolved) {
      logger.warn(
        {
          host,
          tenantId,
          registered: registry.list().map(s => ({ id: s.tenantId, health: s.health, agentUrl: s.agentUrl })),
        },
        'no tenant match',
      );
      res.status(404).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `Tenant '${tenantId}' is not registered` },
      });
      return;
    }

    // MCP transport Accept-header workaround (mirror v5 — clients sending
    // only `application/json` need text/event-stream added so the
    // StreamableHTTP transport's Accept check passes).
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

    try {
      await resolved.server.connect(transport);
      logger.debug({ tenantId: resolved.tenantId, method: req.body?.method }, 'tenant MCP request');
      await runWithSessionContext(async () => {
        await transport.handleRequest(req, res, req.body);
        await flushDirtySessions();
      });
    } catch (err) {
      logger.error({ err, tenantId: resolved.tenantId }, 'tenant MCP error');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal server error' },
        });
      }
    } finally {
      // Close server connection after handling — tenant servers are
      // per-request transient, matching the v5 pattern.
      await resolved.server.close().catch(() => {});
    }
  };
}

/**
 * Mount tenant routes under the training-agent router. Each tenant gets:
 *   POST /<tenant>/mcp   — MCP endpoint
 *   OPTIONS /<tenant>/mcp — CORS preflight
 */
export interface TenantRouteMiddleware {
  /** Rate limiter applied to every tenant POST. */
  rateLimit?: RequestHandler;
  /** Bearer-auth middleware applied to every tenant POST (sets `res.locals.trainingPrincipal`). */
  requireAuth?: RequestHandler;
}

export function mountTenantRoutes(
  parent: Router,
  tenantIds: readonly string[],
  middleware: TenantRouteMiddleware = {},
): void {
  const holder = createRegistryHolder();
  // Eagerly start the 6-tenant registry init at mount time (server boot)
  // instead of waiting for the first request. On a fresh Fly machine the
  // cold init takes 30–60s — longer than the post-deploy smoke's 16s
  // retry budget — which made every deploy fail the smoke even though
  // production was healthy minutes later. Pre-warming shifts that work
  // to before traffic arrives and lets the smoke catch real init bugs
  // (#3854 in-memory task registry, #3869 noopJwksValidator under
  // NODE_ENV=production) without false-failing on cold-start latency.
  //
  // The promise is fire-and-forget here: per-request handlers await the
  // same in-flight promise via `holder.get()`, so a slow init still
  // serves correctly — the eager call only ensures the work has started.
  // Errors are logged; the holder resets `pendingInit` on rejection so
  // the next request retries.
  holder.get().catch((err) => {
    logger.error(
      { err },
      'Eager tenant registry init failed at boot; per-request init will retry',
    );
  });
  const mw: RequestHandler[] = [];
  if (middleware.rateLimit) mw.push(middleware.rateLimit);
  if (middleware.requireAuth) mw.push(middleware.requireAuth);
  for (const tenantId of tenantIds) {
    parent.options(`/${tenantId}/mcp`, (_req, res) => {
      setCORSHeaders(res);
      res.status(204).end();
    });
    parent.post(`/${tenantId}/mcp`, ...mw, tenantMcpHandler(holder, tenantId));
    parent.get(`/${tenantId}/mcp`, (_req, res) => {
      setCORSHeaders(res);
      res.setHeader('Allow', 'POST, OPTIONS');
      res.status(405).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
      });
    });
  }

  // Aggregated brand.json — lists every tenant's public key with its kid.
  // SDK validator calls `new URL('/.well-known/brand.json', agentUrl)` which
  // resolves to host root. For our mount under `/api/training-agent`, the
  // SDK's validator hits the host root path which is OUTSIDE our router —
  // so the spike runs with `autoValidate: false` and we only serve this for
  // discovery / debug introspection.
  parent.get('/.well-known/brand.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ jwks: getAggregatedPublicJwks() });
  });
}
