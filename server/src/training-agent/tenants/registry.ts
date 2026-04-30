/**
 * Multi-tenant TenantRegistry setup.
 *
 * Five tenants — `/sales`, `/signals`, `/creative`, `/governance`, `/brand` —
 * each with its own `DecisioningPlatform` impl, signing key, and specialism
 * declarations. Path-based routing per `cbff7773` (`resolveByRequest(host,
 * pathname)`).
 *
 * Today's wedge: only `/signals` is registered. Other tenants follow as
 * specialism platforms get ported.
 */

import type { Request } from 'express';
import {
  createTenantRegistry,
  type TenantRegistry,
  type CreateAdcpServerFromPlatformOptions,
} from '@adcp/sdk/server';
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
 * No-op JWKS validator for the spike. The SDK's default validator fetches
 * `{agentUrl}/.well-known/brand.json` which resolves to host root — but our
 * brand.json sits under `/api/training-agent/.well-known/brand.json`, not
 * server root. Pre-flight validation can't succeed against the wrong URL.
 *
 * Without a passing validator, tenants are stuck in `'pending'` and the
 * registry refuses traffic. The spike trades pre-flight validation for
 * functionality; AAO certification needs either:
 *   (a) brand.json hosted at server root (path-routed multi-tenant
 *       requires this anyway per RFC 5785), OR
 *   (b) a custom validator that knows our mount path.
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

function buildDefaultServerOptions(): CreateAdcpServerFromPlatformOptions {
  return {
    name: 'adcp-training-agent',
    version: '1.0.0',
    idempotency: getIdempotencyStore(),
    webhooks: getWebhookSigningMaterial(),
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
  get(req: Request): Promise<TenantRegistry>;
}

export function createRegistryHolder(): RegistryHolder {
  let registry: TenantRegistry | null = null;
  let pendingInit: Promise<TenantRegistry> | null = null;

  return {
    async get(req: Request): Promise<TenantRegistry> {
      if (registry) return registry;
      if (pendingInit) return pendingInit;
      void req; // request only used for registry initialization timing; host is stable
      pendingInit = (async () => {
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
      return pendingInit;
    },
  };
}
