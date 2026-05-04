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
  createPostgresTaskRegistry,
  createInMemoryTaskRegistry,
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
 * to in-memory: tests don't initialize the postgres pool and the SDK's
 * `getPool()` throws if called before `initializeDatabase()`.
 *
 * Migration for `adcp_decisioning_tasks` lives at
 * `server/src/db/migrations/463_adcp_decisioning_tasks.sql`.
 */
function pickTaskRegistry(): TaskRegistry {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    return createInMemoryTaskRegistry();
  }
  try {
    return createPostgresTaskRegistry({ pool: getPool() });
  } catch (err) {
    logger.error(
      { err },
      'Postgres task registry init failed in production — falling back to in-memory. ' +
        'Multi-instance task polling will be flaky. Verify migration 463 ran and DATABASE_URL is set.',
    );
    return createInMemoryTaskRegistry();
  }
}

function buildDefaultServerOptions(): CreateAdcpServerFromPlatformOptions {
  return {
    name: 'adcp-training-agent',
    version: '1.0.0',
    idempotency: getIdempotencyStore(),
    webhooks: getWebhookSigningMaterial(),
    taskRegistry: pickTaskRegistry(),
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
}

export function createRegistryHolder(): RegistryHolder {
  let registry: TenantRegistry | null = null;
  let pendingInit: Promise<TenantRegistry> | null = null;

  return {
    async get(): Promise<TenantRegistry> {
      if (registry) return registry;
      if (pendingInit) return pendingInit;
      const promise = (async () => {
        const hostBase = buildHostBaseUrl();
        const reg = createTenantRegistry({
          defaultServerOptions: buildDefaultServerOptions(),
          jwksValidator: noopJwksValidator,
          autoValidate: true,
        });
        const signals = buildSignalsTenantConfig(hostBase);
        const sales = buildSalesTenantConfig(hostBase);
        const governance = buildGovernanceTenantConfig(hostBase);
        const creative = buildCreativeTenantConfig(hostBase);
        const creativeBuilder = buildCreativeBuilderTenantConfig(hostBase);
        const brand = buildBrandTenantConfig(hostBase);
        // awaitFirstValidation:true blocks until the no-op validator
        // promotes the tenant to 'healthy'. Without it the first request
        // would race the background validation and see 'pending' (refused
        // traffic) for the first ~10ms.
        await Promise.all([
          reg.register(signals.tenantId, signals.config, { awaitFirstValidation: true }),
          reg.register(sales.tenantId, sales.config, { awaitFirstValidation: true }),
          reg.register(governance.tenantId, governance.config, { awaitFirstValidation: true }),
          reg.register(creative.tenantId, creative.config, { awaitFirstValidation: true }),
          reg.register(creativeBuilder.tenantId, creativeBuilder.config, { awaitFirstValidation: true }),
          reg.register(brand.tenantId, brand.config, { awaitFirstValidation: true }),
        ]);
        logger.info(
          { hostBase, tenants: ['signals', 'sales', 'governance', 'creative', 'creative-builder', 'brand'] },
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
    },
  };
}
