/**
 * Multi-tenant TenantRegistry setup.
 *
 * Six per-specialism tenants — `/sales`, `/signals`, `/governance`,
 * `/creative`, `/creative-builder`, `/brand` — each with its own
 * `DecisioningPlatform` impl, ephemeral signing key, and specialism
 * declarations. Path-routed: tenants register with `agentUrl` like
 * `${CANONICAL_BASE}/<tenantId>`, the router binds tenantId at route
 * definition and dispatches via `registry.resolveByRequest(canonicalHost,
 * '/<tenantId>/mcp')` — independent of the actual request URL so the same
 * handlers work under host-based dispatch
 * (`test-agent.adcontextprotocol.org/sales/mcp`) and under the local
 * Express mount (`/api/training-agent/sales/mcp` — Express strips the
 * prefix before the router runs).
 *
 * Sandbox semantics: session state and idempotency keys are partitioned
 * by `account.brand.domain` / `account.account_id` in open mode, and by
 * `training:<userId>:<moduleId>` in training mode (see
 * `state.ts:sessionKeyFromArgs`). Neither path includes tenantId — cross-
 * tenant scenarios (a buyer creating a media buy on `/sales/mcp` and
 * checking governance on `/governance/mcp` for the same brand) intentionally
 * share session state. Production sellers that need tenant isolation should
 * key by their authenticated principal upstream of the training agent.
 */

import type { Request } from 'express';
import {
  createTenantRegistry,
  createAdcpServerFromPlatform,
  createPostgresTaskRegistry,
  createInMemoryTaskRegistry,
  InMemoryStateStore,
  PostgresStateStore,
  type AdcpStateStore,
  type TenantRegistry,
  type TaskRegistry,
  type CreateAdcpServerFromPlatformOptions,
} from '@adcp/sdk/server';
import { getPool } from '../../db/client.js';
import { getIdempotencyStore, scopedPrincipal } from '../idempotency.js';
import { getWebhookSigningMaterial } from '../webhooks.js';
import { buildSignalsTenantConfig } from './signals.js';
import { buildSalesTenantConfig } from './sales.js';
import { buildGovernanceTenantConfig } from './governance.js';
import { buildCreativeTenantConfig } from './creative.js';
import { buildCreativeBuilderTenantConfig } from './creative-builder.js';
import { buildBrandTenantConfig } from './brand.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('training-agent-tenants');

/**
 * No-op JWKS validator for the training agent. The SDK's default validator
 * fetches `{agentUrl}/.well-known/brand.json`, which for path-routed tenants
 * resolves to the host-root brand.json (RFC 5785) — our aggregated brand.json
 * lives under the parent training-agent router rather than the host root,
 * so the default validator can't reach it.
 *
 * Without a passing validator, tenants are stuck in `'pending'` and the
 * registry refuses traffic. We trade pre-flight validation for functionality
 * because the training agent is a sandbox where the public keys are already
 * advertised at the parent router. Production agents that ship their own
 * deployment should write a path-aware validator (or move brand.json to
 * host root and drop the no-op).
 *
 * No production guard. An earlier version threw under `NODE_ENV=production`
 * unless `ALLOW_NOOP_JWKS_VALIDATOR=1` was set, on the theory that an adopter
 * might accidentally import the no-op into a production tenant registry that
 * should be enforcing JWKS validation. In practice the only consumer of this
 * file is THIS training agent's production deployment — and that deployment
 * uses the no-op by design (path-mounted brand.json). The guard fired in
 * production, marked every tenant `disabled`, and `resolveByRequest` returned
 * null for every per-tenant POST. Removed.
 */
const noopJwksValidator = {
  async validate() {
    return { ok: true as const };
  },
};

/**
 * Canonical agent URL used as each tenant's `agentUrl` and advertised in
 * `brand.json`. In production this is `https://test-agent.adcontextprotocol.org`;
 * locally it falls back to `http://localhost`. Tenants register at
 * `${CANONICAL_BASE}/<tenantId>` so the path prefix matches `/sales/mcp`,
 * `/signals/mcp`, etc. — the same path Express routes resolve to inside
 * the router regardless of whether the request arrived via host-based
 * dispatch (`test-agent.adcontextprotocol.org/sales/mcp`) or the local
 * mount (`/api/training-agent/sales/mcp` — Express strips the prefix
 * before the router runs).
 */
const CANONICAL_BASE: string = (() => {
  const candidates = [process.env.BASE_URL, process.env.TRAINING_AGENT_URL];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim().replace(/\/$/, '');
    try {
      const url = new URL(trimmed);
      if (url.host) return trimmed;
    } catch {
      // not a valid absolute URL, fall through
    }
  }
  return 'http://localhost';
})();

const CANONICAL_HOST = new URL(CANONICAL_BASE).host;

function buildHostBaseUrl(): string {
  return CANONICAL_BASE;
}

/**
 * Host the registry should match against. Always the canonical host
 * (matching what tenants register with) regardless of the actual Host
 * header on the request — supertest, storyboard runner, and production
 * proxies present different host values, none of which are interesting
 * for tenant resolution.
 */
export function resolveTenantHost(_req: Request): string {
  return CANONICAL_HOST;
}

/**
 * Pick the task registry based on env. Production / staging-like envs MUST
 * use Postgres — we run multiple Fly machines and an in-memory registry
 * would lose task state across instances (buyer creates a media buy on
 * machine A, polls on machine B, sees task-not-found). Test / dev fall back
 * to in-memory: tests don't initialize the postgres pool.
 *
 * The pool is resolved lazily through a `PgQueryable` adapter so
 * `getPool()` doesn't fire at construction. `mountTenantRoutes()` runs
 * before `initializeDatabase()` in the boot order — calling `getPool()`
 * eagerly threw "Database not initialized," and the catch silently
 * downgraded production to the in-memory registry on every cold boot,
 * defeating the whole point of the Postgres backend. Deferring the
 * lookup to first query keeps construction safe and lets the Postgres
 * registry actually be used after the DB is up.
 *
 * Migration for `adcp_decisioning_tasks` lives at
 * `server/src/db/migrations/463_adcp_decisioning_tasks.sql`.
 */
function pickTaskRegistry(): TaskRegistry {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    return createInMemoryTaskRegistry();
  }
  const lazyPool = {
    query: (text: string, values?: unknown[]) => getPool().query(text, values),
  };
  return createPostgresTaskRegistry({ pool: lazyPool });
}

/**
 * Pick the state store. Mirrors `pickTaskRegistry` policy: Postgres in
 * production, in-memory in dev/test.
 *
 * SDK 6.0.1 hard-refuses the module-singleton `InMemoryStateStore`
 * default outside `{NODE_ENV=test, development}` because multi-tenant
 * deployments would silently share state across resolved tenants. Each
 * tenant `register()` runs `createAdcpServer` for that tenant's platform
 * and trips this guard if `stateStore` is absent. Wire `PostgresStateStore`
 * in production; use a fresh `InMemoryStateStore` in dev/test.
 *
 * The pool is resolved lazily through a `PgQueryable` adapter — calling
 * `getPool()` at construction would fail because `mountTenantRoutes()`
 * runs before `initializeDatabase()` in the boot order. Deferring the
 * lookup to first query lets construction succeed; by the time a tool
 * actually touches `ctx.store`, the pool is initialized.
 *
 * Migration: `server/src/db/migrations/466_adcp_state.sql`.
 */
function pickStateStore(): AdcpStateStore {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    return new InMemoryStateStore();
  }
  const lazyPool = {
    query: (text: string, values?: unknown[]) => getPool().query(text, values),
  };
  return new PostgresStateStore(lazyPool);
}

function buildDefaultServerOptions(): CreateAdcpServerFromPlatformOptions {
  return {
    name: 'adcp-training-agent',
    version: '1.0.0',
    idempotency: getIdempotencyStore(),
    webhooks: getWebhookSigningMaterial(),
    taskRegistry: pickTaskRegistry(),
    stateStore: pickStateStore(),
    mergeSeam: 'log-once',
    validation: { requests: 'off', responses: 'off' },
    // F11 — accept loopback push_notification_config.url in non-production.
    // Conformance storyboards bind a loopback HTTP receiver and supply
    // `http://127.0.0.1:<port>/webhook`; production deployments
    // (NODE_ENV=production) keep the SSRF-safe rejection. The framework
    // emits a footgun warning if this is set in production without an
    // ack env, which we tolerate (the warning surfaces operator misconfig).
    allowPrivateWebhookUrls: process.env.NODE_ENV !== 'production',
    resolveIdempotencyPrincipal: (
      ctx: { authInfo?: { clientId?: string } },
      params: Record<string, unknown>,
      _toolName: string,
    ) => {
      const auth = ctx.authInfo?.clientId ?? 'anonymous';
      if (auth !== 'static:public') return auth;
      const account = params.account as { account_id?: string; brand?: { domain?: string } } | undefined;
      const accountScope = account?.account_id
        ? `a:${account.account_id}`
        : account?.brand?.domain
          ? `b:${account.brand.domain.toLowerCase()}`
          : undefined;
      return scopedPrincipal(auth, accountScope);
    },
  };
}

/**
 * Per-router-instance registry holder. Created on first request to capture
 * the actual host (ephemeral port for tests, BASE_URL host in production).
 * One holder per `createTrainingAgentRouter()` call — necessary so multiple
 * server instances in the same process (e.g., test isolation) don't share
 * a cached registry pinned to a stale port.
 */
export interface RegistryHolder {
  /**
   * Resolve the (possibly in-flight) tenant registry. Per-request handlers
   * call this; the first caller triggers init, subsequent callers reuse
   * the same promise.
   */
  get(): Promise<TenantRegistry>;

  /**
   * Create a fresh MCP server for a single HTTP request. The MCP SDK
   * requires one Server instance per connection — calling connect() on
   * a shared server while it is already connected throws
   * "Already connected to a transport." This factory creates a new
   * Protocol instance each time so concurrent requests to the same
   * tenant each get an independent server, matching the SDK's stateless
   * mode expectation (sessionIdGenerator: undefined).
   *
   * Returns null if the tenant is not registered (shouldn't happen when
   * called after a successful resolveByRequest, but defended for safety).
   */
  createServer(tenantId: string): ReturnType<typeof createAdcpServerFromPlatform> | null;
}

export function createRegistryHolder(): RegistryHolder {
  let registry: TenantRegistry | null = null;
  let pendingInit: Promise<TenantRegistry> | null = null;
  // Per-tenant server factories. Populated during init and used by
  // createServer() to produce a fresh MCP Server per HTTP request.
  const serverFactories = new Map<string, () => ReturnType<typeof createAdcpServerFromPlatform>>();

  async function ensureInit(): Promise<TenantRegistry> {
    if (registry) return registry;
    if (pendingInit) return pendingInit;
    const promise = (async () => {
      const t0 = Date.now();
      logger.info('Tenant registry init starting');
      const hostBase = buildHostBaseUrl();
      const reg = createTenantRegistry({
        defaultServerOptions: buildDefaultServerOptions(),
        jwksValidator: noopJwksValidator,
        autoValidate: true,
      });
      const tCreate = Date.now();
      const configs = [
        { id: 'signals', cfg: buildSignalsTenantConfig(hostBase) },
        { id: 'sales', cfg: buildSalesTenantConfig(hostBase) },
        { id: 'governance', cfg: buildGovernanceTenantConfig(hostBase) },
        { id: 'creative', cfg: buildCreativeTenantConfig(hostBase) },
        { id: 'creative-builder', cfg: buildCreativeBuilderTenantConfig(hostBase) },
        { id: 'brand', cfg: buildBrandTenantConfig(hostBase) },
      ] as const;
      const tConfigs = Date.now();

      // Build per-tenant server factories before registration. Each factory
      // merges the shared default options with the tenant-specific platform
      // and serverOptions so createServer() can spin up a fresh Protocol
      // instance per HTTP request without re-registering.
      const defaultOpts = buildDefaultServerOptions();
      for (const { cfg } of configs) {
        const opts: CreateAdcpServerFromPlatformOptions = {
          ...defaultOpts,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          platform: cfg.config.platform as any,
          ...(cfg.config.serverOptions ?? {}),
        };
        // Key by cfg.tenantId (the value passed to reg.register) so the factory
        // map and the registry use the same source of truth.
        serverFactories.set(cfg.tenantId, () => createAdcpServerFromPlatform(opts));
      }

      // awaitFirstValidation:true blocks until the no-op validator
      // promotes the tenant to 'healthy'. Without it the first request
      // would race the background validation and see 'pending' (refused
      // traffic) for the first ~10ms.
      await Promise.all(
        configs.map(async ({ id, cfg }) => {
          const start = Date.now();
          try {
            await reg.register(cfg.tenantId, cfg.config, { awaitFirstValidation: true });
            logger.info({ tenantId: id, elapsedMs: Date.now() - start }, 'Tenant registered');
          } catch (err) {
            logger.error(
              {
                err,
                errMessage: err instanceof Error ? err.message : String(err),
                errStack: err instanceof Error ? err.stack : undefined,
                tenantId: id,
                elapsedMs: Date.now() - start,
              },
              'Tenant register failed',
            );
            throw err;
          }
        }),
      );
      logger.info(
        {
          hostBase,
          createMs: tCreate - t0,
          configBuildMs: tConfigs - tCreate,
          registerMs: Date.now() - tConfigs,
          totalMs: Date.now() - t0,
          tenants: configs.map(c => c.id),
        },
        'Tenant registry initialized',
      );
      registry = reg;
      return reg;
    })();
    // Reset pendingInit on rejection so a transient init failure (e.g.,
    // DNS hiccup during the no-op validator's first probe) doesn't
    // poison every subsequent request with the same rejected promise
    // until machine restart.
    promise.catch(() => { pendingInit = null; });
    pendingInit = promise;
    return promise;
  }

  return {
    get: ensureInit,

    createServer(tenantId: string): ReturnType<typeof createAdcpServerFromPlatform> | null {
      const factory = serverFactories.get(tenantId);
      return factory ? factory() : null;
    },
  };
}
