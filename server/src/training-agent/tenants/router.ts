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

    const host = resolveTenantHost(req);
    const registry = await holder.get(req);
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
