/**
 * v6 SalesPlatform for the `/sales` tenant.
 *
 * Single-specialism platform claiming `sales-non-guaranteed` +
 * `sales-guaranteed`. Implements `SalesPlatform` (5 required methods +
 * 4 optional read-side methods).
 *
 * Spike-grade port: bodies shim through to existing v5 handlers via
 * `translateV5Result`. Same approach as `/signals` — validates framework
 * wiring against the storyboard suite first; native porting (handler
 * bodies that throw `AdcpError` directly) is a follow-up.
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
} from '@adcp/sdk/server';
import {
  handleGetProducts,
  handleCreateMediaBuy,
  handleUpdateMediaBuy,
  handleGetMediaBuys,
  handleGetMediaBuyDelivery,
  handleSyncCreatives,
  handleListCreatives,
  handleListCreativeFormats,
} from './task-handlers.js';
import { handleProvidePerformanceFeedback } from './catalog-event-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingSalesMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingSalesConfig {
  strict: boolean;
}

/** Build a TrainingContext from a v6 RequestContext.Account.authInfo. */
function buildTrainingCtx(account: { authInfo?: { principal?: string } } | undefined): TrainingContext {
  return {
    mode: 'open',
    principal: account?.authInfo?.principal ?? 'anonymous',
  };
}


/**
 * v5 → v6 envelope translator. v5 handlers return `{ errors: [...] }` for
 * structured rejection; v6 platform methods throw `AdcpError`.
 */
function translateV5Result<T extends object>(result: unknown): T {
  const errs = (result as {
    errors?: Array<{
      code: string;
      message: string;
      field?: string;
      details?: unknown;
      recovery?: string;
    }>;
  } | undefined)?.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const first = errs[0]!;
    const recovery = (first.recovery === 'transient' || first.recovery === 'correctable' || first.recovery === 'terminal')
      ? first.recovery
      : 'correctable';
    throw new AdcpError(first.code, {
      recovery,
      message: first.message,
      ...(first.field !== undefined && { field: first.field }),
      ...(first.details !== undefined && { details: first.details as Record<string, unknown> }),
    });
  }
  return result as T;
}

/**
 * Synthetic-account constructor — same posture as the signals tenant.
 * v6 mandates `accounts.resolve()` on every request; we synthesize an
 * Account from the wire reference (or from auth for no-account tools
 * like `provide_performance_feedback` and `list_creative_formats`).
 *
 * `upsert` delegates to the v5 `handleSyncAccounts` so the BILLING_NOT_SUPPORTED
 * + BILLING_NOT_PERMITTED_FOR_AGENT gates (landed in #3851) fire identically
 * on the v6 per-tenant `/api/training-agent/sales/mcp` route as on the
 * legacy `/mcp` route. Principal flows from the bearer authenticator
 * through `ctx.authInfo` into the v5 handler's `ctx.principal`, where the
 * per-agent gate consults the commercial-relationships map.
 */
const trainingSalesAccounts: AccountStore<TrainingSalesMeta> = {
  resolution: 'explicit',
  resolve: async (ref, _ctx) => {
    if (ref == null) {
      return {
        id: 'public_sandbox',
        name: 'Public Sandbox',
        status: 'active',
        ctx_metadata: {},
        sandbox: true,
        authInfo: { kind: 'public' },
      };
    }
    const brandDomain =
      'brand' in ref && ref.brand && typeof ref.brand === 'object' && 'domain' in ref.brand
        ? (ref.brand.domain as string | undefined)
        : undefined;
    const accountId =
      'account_id' in ref && typeof ref.account_id === 'string' ? ref.account_id : undefined;
    const id = accountId ?? `synthetic_${brandDomain ?? 'anon'}`;
    return {
      id,
      name: brandDomain ?? id,
      status: 'active',
      ...(brandDomain != null && { brand: { domain: brandDomain } }),
      ...('operator' in ref && typeof ref.operator === 'string' && { operator: ref.operator }),
      ctx_metadata: { brand_domain: brandDomain },
      sandbox: true,
      authInfo: { kind: 'api_key' },
    };
  },
  upsert: syncAccountsUpsert,
};

export class TrainingSalesPlatform
  implements DecisioningPlatform<TrainingSalesConfig, TrainingSalesMeta>
{
  capabilities = {
    specialisms: ['sales-non-guaranteed', 'sales-guaranteed'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm', 'cpa'] as const,
    targeting: {
      geo_countries: true,
      geo_regions: true,
      geo_metros: { nielsen_dma: true },
      geo_postal_areas: { us_zip: true },
      language: true,
      keyword_targets: { supported_match_types: ['broad', 'phrase', 'exact'] as const },
      negative_keywords: { supported_match_types: ['broad', 'phrase', 'exact'] as const },
    },
    audience_targeting: {
      supported_identifier_types: ['hashed_email' as const],
      minimum_audience_size: 100,
    },
    conversion_tracking: {
      supported_event_types: ['purchase' as const, 'add_to_cart' as const, 'lead' as const, 'page_view' as const],
      supported_hashed_identifiers: ['hashed_email' as const],
      supported_action_sources: ['website' as const, 'app' as const],
    },
    supportedBillings: ['agent', 'operator'] as const,
    // Auto-derives `compliance_testing.scenarios[]` from the adapters
    // wired in `serverOptions.complyTest`. Empty block opts in; the
    // capability/adapter consistency check at construction throws if
    // adapters aren't supplied alongside.
    compliance_testing: {},
    config: { strict: false },
  };

  statusMappers = {};
  accounts: AccountStore<TrainingSalesMeta> = trainingSalesAccounts;
  agentRegistry = trainingBuyerAgentRegistry;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sales: SalesPlatform<TrainingSalesMeta> = {
    getProducts: async (req, ctx) => {
      const result = await handleGetProducts(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },

    createMediaBuy: async (req, ctx) => {
      const v5Result = await handleCreateMediaBuy(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(v5Result);
    },

    updateMediaBuy: async (buyId, patch, ctx) => {
      const args = { media_buy_id: buyId, ...(patch as unknown as Record<string, unknown>) };
      const v5Result = await handleUpdateMediaBuy(args as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(v5Result);
    },

    syncCreatives: async (creatives, ctx) => {
      // Thread brand domain through so `sessionKeyFromArgs` in the v5
      // handler resolves to the same session the test-controller seeded
      // creative_policy against. Without this, sync_creatives lands in
      // `open:default` while the seeded products live on `open:<brand>`,
      // and `aggregateCreativePolicy` returns null — provenance
      // enforcement silently no-ops.
      const brandDomain = (ctx.account as { ctx_metadata?: { brand_domain?: string } } | undefined)?.ctx_metadata?.brand_domain;
      const args = brandDomain ? { creatives, brand: { domain: brandDomain } } : { creatives };
      const v5Result = await handleSyncCreatives(args as unknown as ToolArgs, buildTrainingCtx(ctx.account));
      // v5 returns wire-wrapped `{ creatives: [...] }`; v6 SalesPlatform
      // wants rows directly — framework re-wraps.
      const wrapped = translateV5Result<{ creatives?: unknown[] }>(v5Result);
      return (wrapped.creatives ?? []) as Awaited<ReturnType<NonNullable<SalesPlatform['syncCreatives']>>>;
    },

    getMediaBuyDelivery: async (filter, ctx) => {
      const result = await handleGetMediaBuyDelivery(filter as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },

    // Optional read-side methods.
    getMediaBuys: async (req, ctx) => {
      const result = await handleGetMediaBuys(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },

    listCreativeFormats: async (req, ctx) => {
      const result = await handleListCreativeFormats(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },

    listCreatives: async (req, ctx) => {
      const result = await handleListCreatives(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },

    providePerformanceFeedback: async (req, ctx) => {
      const result = await handleProvidePerformanceFeedback(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
  };
}
