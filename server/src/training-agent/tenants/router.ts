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

import { createHash } from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from '../../logger.js';
import { runWithSessionContext, flushDirtySessions } from '../state.js';
import { createRegistryHolder, getCanonicalBase, resolveTenantHost, type RegistryHolder } from './registry.js';
import { buildSignedRevocationList } from '../governance-revocations.js';
import { salesCapabilityProjection } from '../v6-sales-platform.js';
import { handleComplyTestController } from '../comply-test-controller.js';
import { adcpError, resolveServedAdcpVersion, supportedCanonicalFormatsCapability } from '../task-handlers.js';
import type { TrainingContext } from '../types.js';
import { getAgentUrl } from '../config.js';

const logger = createLogger('training-agent-tenant-router');
const PRODUCT_WHOLESALE_EVENTS = ['product.created', 'product.updated', 'product.priced', 'product.removed'] as const;
const SIGNAL_WHOLESALE_EVENTS = ['signal.created', 'signal.updated', 'signal.priced', 'signal.removed'] as const;

const SALES_LEGACY_CAPABILITY_SCENARIOS = [
  'force_creative_status',
  'force_media_buy_status',
  'simulate_delivery',
  'simulate_budget_spend',
] as const;

const SALES_THREE_ZERO_COMPLY_SCENARIOS = [
  ...SALES_LEGACY_CAPABILITY_SCENARIOS,
  'force_create_media_buy_arm',
  'force_task_completion',
  'seed_product',
  'seed_pricing_option',
  'seed_creative',
  'seed_media_buy',
  'seed_creative_format',
] as const;

const SALES_CURRENT_SCENARIOS = [
  ...SALES_LEGACY_CAPABILITY_SCENARIOS,
  'force_create_media_buy_arm',
  'force_task_completion',
  'force_creative_purge',
  'force_upstream_unavailable',
  'seed_account',
  'seed_product',
  'seed_pricing_option',
  'seed_creative',
  'seed_media_buy',
  'seed_creative_format',
  'seed_measurement_catalog',
  'query_provenance_audit_observations',
  'evaluate_distributed_brand_resolution',
] as const;

const TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS = ['3.0', '3.1-beta.5', '3.1-beta.7', '3.1-rc.4', '3.1-rc.6', '3.1-rc.7', '3.1-rc.8', '3.1-rc.9', '3.1-rc.10'] as const;
const TRAINING_AGENT_DEFAULT_ADCP_VERSION = '3.0';

function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const scheme = 'bearer';
    if (
      auth.length > scheme.length
      && auth.slice(0, scheme.length).toLowerCase() === scheme
      && (auth[scheme.length] === ' ' || auth[scheme.length] === '\t')
    ) {
      const token = auth.slice(scheme.length + 1).trim();
      if (token.length > 0) return token;
    }
  }
  const legacy = req.headers['x-adcp-auth'];
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

function apiKeyCredential(req: Request, principal: string): { kind: 'api_key'; key_id: string } {
  // Mirror @adcp/sdk's verifyApiKey key_id shape: SHA-256(token), truncated
  // to 32 hex chars. The tenant router uses custom Express middleware, so it
  // must bridge the credential field that serve().attachAuthInfo would have
  // stamped for the SDK's buyer-agent registry.
  const token = bearerToken(req) ?? principal;
  return {
    kind: 'api_key',
    key_id: createHash('sha256').update(token).digest('hex').slice(0, 32),
  };
}

function salesComplyScenarios(storyboardCompat?: TrainingContext['storyboardCompat']): string[] {
  return storyboardCompat?.version === '3.0'
    ? [...SALES_THREE_ZERO_COMPLY_SCENARIOS]
    : [...SALES_CURRENT_SCENARIOS];
}

function salesCapabilityScenarios(storyboardCompat?: TrainingContext['storyboardCompat']): string[] {
  return storyboardCompat?.version === '3.0'
    ? [...SALES_LEGACY_CAPABILITY_SCENARIOS]
    : [...SALES_CURRENT_SCENARIOS];
}

/**
 * Per-tenant connect-handle-close serializer.
 *
 * The framework hands us one `DecisioningAdcpServer` instance per tenant.
 * Each MCP request creates a fresh `StreamableHTTPServerTransport`,
 * `.connect()`s the shared server to it, handles the request, and
 * `.close()`s. Two requests against the same tenant overlap mid-handler
 * and the second `.connect()` throws "Already connected to a transport"
 * — surfaced as intermittent 500s under back-to-back load (adcp#4084).
 *
 * Serialize the connect-handle-close window per tenant so the shared
 * server only ever has one transport bound at a time. Throughput is
 * gated by the in-flight request's wallclock; the storyboard runner's
 * sequential dispatch makes this a non-issue in practice, and the
 * compliance heartbeat runs once per agent at a time. A future fix
 * could pool servers per tenant for true parallelism — this lock is
 * the minimum-mass correctness change.
 *
 * Lock scope intentionally includes `flushDirtySessions` (DB I/O) and
 * `server.close()`, not just `connect`/`handleRequest`. Session state
 * mutations from request N must be persisted before request N+1 runs
 * against the same shared server — narrowing the lock to just the
 * transport window would race on the in-memory session-context state
 * the v5 handlers mutate. DB-flush latency is acceptable here because
 * the training agent's call pattern is sequential per tenant in the
 * storyboard runner / heartbeat. Don't narrow the lock without first
 * partitioning session state per request.
 */
const tenantLocks = new Map<string, Promise<unknown>>();

async function withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tenantLocks.get(tenantId) ?? Promise.resolve();
  // Chain this work after the prior in-flight request and store the new
  // tail in the map. `.catch(() => {})` keeps the chain alive if a prior
  // request rejects — the next waiter still gets to run. The original
  // caller's rejection propagates via the `next` promise we return below
  // (`.then(fn)` keeps the success/failure shape from `fn` itself); only
  // the chain-keepalive copy swallows the prior error. Don't "fix" the
  // catch by removing it: without it, one rejected request poisons every
  // subsequent same-tenant request via the shared map entry.
  //
  // The map entry is one promise per tenant; we don't GC because the
  // cost is constant in N tenants (small, fixed set: sales/signals/
  // governance/creative/creative-builder/brand) and the entry is
  // overwritten on every call.
  const next = previous.catch(() => {}).then(fn);
  tenantLocks.set(tenantId, next);
  return next;
}

function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, Signature, Signature-Input, Content-Digest');
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
function tenantMcpHandler(holder: RegistryHolder, tenantId: string, storyboardCompat?: TrainingContext['storyboardCompat']) {
  return async (req: Request, res: Response): Promise<void> => {
    setCORSHeaders(res);

    wrapTenantToolDiscoveryProjection(req, res, storyboardCompat);
    wrapSalesCapabilitiesProjection(req, res, tenantId, storyboardCompat);

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
      const demoToken = principal.startsWith('static:demo:')
        ? principal.slice('static:demo:'.length)
        : undefined;
      (req as {
        auth: {
          token: string;
          clientId: string;
          scopes: string[];
          extra: Record<string, unknown>;
        };
      }).auth = {
        token: '',
        clientId: principal,
        scopes: [],
        extra: {
          ...(demoToken !== undefined && { demo_token: demoToken }),
          credential: apiKeyCredential(req, principal),
        },
      };
    }

    const host = resolveTenantHost(req);
    const registry = await holder.get().catch((err: unknown) => {
      // Surfacing the rejection here is what makes #3854 / #3869-class
      // init bugs visible. Without it the rejection escapes to Express's
      // default error handler — the smoke sees an HTML 500 with no JSON
      // body and no log entry tying the error to the rejected promise.
      logger.error(
        {
          err,
          errMessage: err instanceof Error ? err.message : String(err),
          errName: err instanceof Error ? err.name : undefined,
          errStack: err instanceof Error ? err.stack : undefined,
          errCause: err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined,
          tenantId,
          host,
        },
        'tenant registry init rejected — request failed before dispatch',
      );
      // 503 + Retry-After matches the SDK's documented contract for
      // pending tenants (`tenant-registry.d.ts`: "host transport should
      // respond 503 + Retry-After"). 5s is short enough that the smoke's
      // 8s retry catches a transient warmup, long enough for a fresh
      // Fly machine to finish per-tenant register.
      res.setHeader('Retry-After', '5');
      res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Tenant registry warming up; retry shortly' },
      });
      return null;
    });
    if (registry === null) return;
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

    // Serialize the connect/handle/close window per tenant — see
    // `withTenantLock` above for the race this prevents (adcp#4084).
    await withTenantLock(resolved.tenantId, async () => {
      if (
        principal
        && req.body?.method === 'tools/call'
        && req.body?.params?.name === 'comply_test_controller'
        && req.body.params.arguments
        && typeof req.body.params.arguments === 'object'
      ) {
        req.body.params.arguments.__training_principal = principal;
      }

      if (await tryHandleLocalComplyScenario(req, res, resolved.tenantId, principal, storyboardCompat)) {
        return;
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
    });
  };
}

async function tryHandleLocalComplyScenario(
  req: Request,
  res: Response,
  tenantId: string,
  principal: string | undefined,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): Promise<boolean> {
  if (tenantId !== 'sales') return false;
  if (req.body?.method !== 'tools/call') return false;
  if (req.body?.params?.name !== 'comply_test_controller') return false;

  const rawArgs = (req.body.params.arguments ?? {}) as Record<string, unknown>;
  const isThreeZeroCompat = storyboardCompat?.version === '3.0';
  if (
    rawArgs.scenario !== 'seed_measurement_catalog'
    && rawArgs.scenario !== 'force_creative_purge'
    && rawArgs.scenario !== 'query_provenance_audit_observations'
    && rawArgs.scenario !== 'evaluate_distributed_brand_resolution'
    && rawArgs.scenario !== 'list_scenarios'
  ) return false;
  if (
    isThreeZeroCompat
    && (
      rawArgs.scenario === 'seed_measurement_catalog'
      || rawArgs.scenario === 'force_creative_purge'
      || rawArgs.scenario === 'query_provenance_audit_observations'
      || rawArgs.scenario === 'evaluate_distributed_brand_resolution'
    )
  ) return false;

  const { context, ...handlerArgs } = rawArgs;
  const versionResolution = resolveServedAdcpVersion(handlerArgs);
  if (!versionResolution.ok) {
    res.json({
      jsonrpc: '2.0',
      id: req.body.id ?? null,
      result: adcpError('VERSION_UNSUPPORTED', {
        message: versionResolution.message,
        details: versionResolution.details,
        field: versionResolution.field,
      }, context),
    });
    return true;
  }

  const result = await runWithSessionContext(async () => {
    const body = rawArgs.scenario === 'list_scenarios'
      ? {
          success: true,
          scenarios: salesComplyScenarios(storyboardCompat),
        }
      : await handleComplyTestController(handlerArgs, {
          mode: 'open',
          principal: principal ?? 'anonymous',
        });
    await flushDirtySessions();
    return body as Record<string, unknown>;
  });
  const structuredContent = {
    status: 'completed',
    adcp_version: versionResolution.servedVersion,
    ...result,
    ...(context !== undefined && { context }),
  };
  res.json({
    jsonrpc: '2.0',
    id: req.body.id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  });
  return true;
}

function wrapSalesCapabilitiesProjection(
  req: Request,
  res: Response,
  tenantId: string,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): void {
  if (req.body?.method !== 'tools/call') return;
  if (req.body?.params?.name !== 'get_adcp_capabilities') return;

  const origEnd = res.end.bind(res);
  const chunks: Buffer[] = [];
  stripContentLengthOnWriteHead(res);

  (res as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    if (chunk !== null && chunk !== undefined) chunks.push(toBuffer(chunk));
    const cb = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
    if (cb) queueMicrotask(cb);
    return true;
  };

  (res as unknown as { end: (...args: unknown[]) => Response }).end = (chunk?: unknown, ...rest: unknown[]) => {
    if (chunk !== null && chunk !== undefined) chunks.push(toBuffer(chunk));
    const body = Buffer.concat(chunks);
    const patched = projectSalesCapabilities(body, tenantId, storyboardCompat);
    if (patched !== body && !res.headersSent) {
      res.setHeader('content-length', String(patched.length));
    }
    return origEnd(patched, ...rest as []);
  };
}

function wrapTenantToolDiscoveryProjection(
  req: Request,
  res: Response,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): void {
  if (req.body?.method !== 'tools/list') return;

  const origEnd = res.end.bind(res);
  const chunks: Buffer[] = [];
  stripContentLengthOnWriteHead(res);

  (res as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    if (chunk !== null && chunk !== undefined) chunks.push(toBuffer(chunk));
    const cb = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
    if (cb) queueMicrotask(cb);
    return true;
  };

  (res as unknown as { end: (...args: unknown[]) => Response }).end = (chunk?: unknown, ...rest: unknown[]) => {
    if (chunk !== null && chunk !== undefined) chunks.push(toBuffer(chunk));
    const body = Buffer.concat(chunks);
    const patched = projectTenantToolDiscovery(body, storyboardCompat);
    if (patched !== body && !res.headersSent) {
      res.setHeader('content-length', String(patched.length));
    }
    return origEnd(patched, ...rest as []);
  };
}

function projectTenantToolDiscovery(
  body: Buffer,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): Buffer {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      result?: {
        tools?: Array<{ name?: string }>;
      };
    };
    const tools = parsed.result?.tools;
    if (!Array.isArray(tools)) return body;
    if (storyboardCompat?.version !== '3.0') return body;
    parsed.result!.tools = tools.filter(tool => tool.name !== 'validate_input');
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return body;
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function stripContentLengthOnWriteHead(res: Response): void {
  const original = res.writeHead.bind(res) as unknown as (...args: unknown[]) => Response;
  (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = (...args: unknown[]) => {
    if (!res.headersSent) {
      res.removeHeader('content-length');
    }
    const next = [...args];
    for (let i = 1; i < next.length; i += 1) {
      const value = next[i];
      if (Array.isArray(value)) {
        next[i] = value.filter((entry, index, array) => {
          if (index % 2 === 1) return String(array[index - 1]).toLowerCase() !== 'content-length';
          return String(entry).toLowerCase() !== 'content-length';
        });
      } else if (value && typeof value === 'object') {
        const headers = { ...(value as Record<string, unknown>) };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-length') delete headers[key];
        }
        next[i] = headers;
      }
    }
    return original(...next);
  };
}

function projectSalesCapabilities(
  body: Buffer,
  tenantId: string,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): Buffer {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      result?: {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: {
          adcp_version?: unknown;
          adcp?: Record<string, unknown>;
          supported_protocols?: unknown;
          creative?: Record<string, unknown>;
          media_buy?: Record<string, unknown>;
          signals?: Record<string, unknown>;
          wholesale_feed_versioning?: Record<string, unknown>;
          wholesale_feed_webhooks?: Record<string, unknown>;
          webhook_signing?: Record<string, unknown>;
          identity?: Record<string, unknown>;
          compliance_testing?: Record<string, unknown>;
        };
      };
    };
    const structured = parsed.result?.structuredContent;
    if (!structured || typeof structured !== 'object') return body;
    const servedVersion = typeof structured.adcp_version === 'string'
      ? structured.adcp_version
      : TRAINING_AGENT_DEFAULT_ADCP_VERSION;
    structured.adcp_version = servedVersion;
    const adcp = structured.adcp && typeof structured.adcp === 'object'
      ? structured.adcp
      : {};
    structured.adcp = {
      ...adcp,
      supported_versions: Array.isArray(adcp.supported_versions)
        ? adcp.supported_versions
        : [...TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS],
    };
    if ((tenantId === 'creative' || tenantId === 'creative-builder') && storyboardCompat?.version !== '3.0') {
      const creative = structured.creative && typeof structured.creative === 'object'
        ? structured.creative
        : {};
      structured.creative = {
        ...creative,
        ...(tenantId === 'creative' ? { bills_through_adcp: false } : {}),
        supports_transformers: true,
        supports_refinement: true,
        refinable_retention_seconds: 3600,
        multiplicity: {
          supports_catalog_fanout: false,
          supports_variants: true,
          max_variants_limit: 10,
          variant_dimensions: ['voice', 'theme', 'best_of_n', 'transformer_config', 'custom'],
        },
      };
    }
    if (tenantId === 'sales') {
      const mediaBuy = structured.media_buy && typeof structured.media_buy === 'object'
        ? structured.media_buy
        : {};
      const salesProjection = salesCapabilityProjection();
      structured.media_buy = {
        ...mediaBuy,
        ...salesProjection,
        features: {
          ...(
            mediaBuy.features && typeof mediaBuy.features === 'object'
              ? mediaBuy.features as Record<string, unknown>
              : {}
          ),
          ...salesProjection.features,
        },
      };
      const creative = structured.creative && typeof structured.creative === 'object'
        ? structured.creative
        : {};
      structured.creative = {
        ...creative,
        bills_through_adcp: false,
        supported_formats: supportedCanonicalFormatsCapability(),
        canonical_catalog_version: '3.1',
      };
      const complianceTesting = structured.compliance_testing && typeof structured.compliance_testing === 'object'
        ? structured.compliance_testing
        : {};
      const capabilityScenarios = salesCapabilityScenarios(storyboardCompat);
      const existingCapabilityScenarios = Array.isArray((complianceTesting as { scenarios?: unknown }).scenarios)
        ? (complianceTesting as { scenarios: unknown[] }).scenarios.filter((s): s is string => typeof s === 'string')
        : [];
      const scenarios = new Set(
        storyboardCompat?.version === '3.0'
          ? capabilityScenarios
          : existingCapabilityScenarios,
      );
      for (const scenario of capabilityScenarios) {
        scenarios.add(scenario);
      }
      structured.compliance_testing = {
        ...complianceTesting,
        scenarios: [...scenarios],
      };
    }
    projectWholesaleCapabilities(structured, tenantId, storyboardCompat);
    const firstText = parsed.result?.content?.[0];
    if (firstText?.type === 'text') {
      firstText.text = JSON.stringify(structured);
    }
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return body;
  }
}

function projectWholesaleCapabilities(
  structured: {
    media_buy?: Record<string, unknown>;
    signals?: Record<string, unknown>;
    wholesale_feed_versioning?: Record<string, unknown>;
    wholesale_feed_webhooks?: Record<string, unknown>;
    webhook_signing?: Record<string, unknown>;
    identity?: Record<string, unknown>;
  },
  tenantId: string,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): void {
  if (storyboardCompat?.version === '3.0') {
    delete structured.wholesale_feed_versioning;
    delete structured.wholesale_feed_webhooks;
    return;
  }

  const productWholesale = tenantId === 'sales';
  const signalWholesale = tenantId === 'signals';
  if (!productWholesale && !signalWholesale) {
    delete structured.wholesale_feed_versioning;
    delete structured.wholesale_feed_webhooks;
    return;
  }

  if (productWholesale) {
    const mediaBuy = structured.media_buy && typeof structured.media_buy === 'object' ? structured.media_buy : {};
    structured.media_buy = { ...mediaBuy, buying_modes: ['brief', 'wholesale', 'refine'] };
    delete structured.signals;
  }

  if (signalWholesale) {
    const signals = structured.signals && typeof structured.signals === 'object' ? structured.signals : {};
    const features = signals.features && typeof signals.features === 'object' ? signals.features as Record<string, unknown> : {};
    structured.signals = {
      ...signals,
      discovery_modes: ['brief', 'wholesale'],
      features: { ...features, catalog_signals: true },
    };
  }

  structured.wholesale_feed_versioning = {
    supported: true,
    pricing_version_separate: true,
    cache_scope_account: true,
  };
  structured.wholesale_feed_webhooks = {
    supported: true,
    event_types: [
      ...(productWholesale ? PRODUCT_WHOLESALE_EVENTS : []),
      ...(signalWholesale ? SIGNAL_WHOLESALE_EVENTS : []),
      'wholesale_feed.bulk_change',
    ],
  };
  structured.webhook_signing = {
    supported: true,
    profile: 'adcp/webhook-signing/v1',
    algorithms: ['ed25519'],
    legacy_hmac_fallback: true,
  };
  structured.identity = {
    ...(structured.identity ?? {}),
    brand_json_url: `${getAgentUrl()}/.well-known/brand.json`,
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
  /** Local storyboard-runner compatibility shims. Never set in deployed routes. */
  storyboardCompat?: TrainingContext['storyboardCompat'];
}

export function mountTenantRoutes(
  parent: Router,
  tenantIds: readonly string[],
  middleware: TenantRouteMiddleware = {},
): void {
  const holder = createRegistryHolder({ storyboardCompat: middleware.storyboardCompat });
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
      {
        err,
        errMessage: err instanceof Error ? err.message : String(err),
        errName: err instanceof Error ? err.name : undefined,
        errStack: err instanceof Error ? err.stack : undefined,
        errCause: err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined,
      },
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
    parent.post(`/${tenantId}/mcp`, ...mw, tenantMcpHandler(holder, tenantId, middleware.storyboardCompat));
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

  // brand.json discovery is mounted at the parent training-agent router in
  // `../index.ts` (schema-conformant per `static/schemas/source/brand.json`
  // oneOf[3]). `getAggregatedPublicJwks()` remains exported for direct
  // callers (governance-signing tests) — buyer-side fetchers walk the
  // chain via brand.json `agents[].jwks_uri` pointers instead of an
  // aggregated top-level JWKS.

  // Signed governance revocation list. Spec requires governance agents to
  // publish this at `{origin of iss}/.well-known/governance-revocations.json`;
  // sellers and auditors poll on the cadence declared in `next_update` and
  // reject any token whose jti or kid appears in the list. The training
  // agent's list is signed-empty by design — the sandbox does not exercise
  // revocation but the endpoint must exist for the JWS profile's fetch-and-
  // parse conformance tests to pass.
  parent.get('/.well-known/governance-revocations.json', async (_req, res, next) => {
    try {
      const signed = await buildSignedRevocationList(`${getCanonicalBase()}/governance`);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(signed);
    } catch (err) {
      next(err);
    }
  });
}
