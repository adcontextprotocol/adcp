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
  type AudiencePlatform,
  type SyncAudiencesRow,
  type AudienceStatus,
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
  hasAdcpSuccessPayload,
} from './task-handlers.js';
import {
  handleProvidePerformanceFeedback,
  handleSyncEventSources,
  handleLogEvent,
} from './catalog-event-handlers.js';
import { handleSyncAudiences } from './audience-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import { pickFromInput } from './v6-input-helpers.js';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingSalesMeta {
  brand_domain?: string;
  operator?: string;
  [key: string]: unknown;
}

interface TrainingSalesConfig {
  strict: boolean;
}

export const TRAINING_SALES_CAPABILITIES = {
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
  // Seller-level rollup of metric-optimization capabilities. Honest union
  // across catalog products (product-factory.ts assigns these by channel mix).
  // The tenant router projects these fields onto get_adcp_capabilities until
  // the SDK exposes them directly (adcp-client#1818).
  supported_optimization_metrics: ['clicks' as const, 'views' as const, 'completed_views' as const, 'engagements' as const, 'reach' as const],
  vendor_metric_optimization: {
    supported_targets: ['threshold_rate' as const],
  },
  supportedBillings: ['agent', 'operator'] as const,
  // Auto-derives `compliance_testing.scenarios[]` from the adapters wired in
  // `serverOptions.complyTest`. Empty block opts in; the capability/adapter
  // consistency check at construction throws if adapters aren't supplied.
  compliance_testing: {},
  config: { strict: false },
};

export function salesCapabilityProjection() {
  return {
    supported_optimization_metrics: [...TRAINING_SALES_CAPABILITIES.supported_optimization_metrics],
    vendor_metric_optimization: {
      supported_targets: [...TRAINING_SALES_CAPABILITIES.vendor_metric_optimization.supported_targets],
    },
  };
}

/** Build a TrainingContext from the v6 request context auth bridge. */
function buildTrainingCtx(
  ctx: { account?: { authInfo?: { principal?: string } }; authInfo?: { clientId?: string } } | undefined,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): TrainingContext {
  return {
    mode: 'open',
    principal: ctx?.authInfo?.clientId ?? ctx?.account?.authInfo?.principal ?? 'anonymous',
    ...(storyboardCompat && { storyboardCompat }),
  };
}

/**
 * Extract the brand domain from a resolved v6 Account so v5 handlers can
 * derive the correct session key via sessionKeyFromArgs. The v6 SDK resolves
 * `account.brand.domain` into `ctx_metadata.brand_domain` on the Account
 * object but does NOT re-inject it into domain-level args (req / filter /
 * patch), so handlers that rely on sessionKeyFromArgs need it threaded in
 * explicitly. Same fix as syncCreatives — see comment there.
 */
function brandDomainFromCtx(account: unknown): string | undefined {
  return (account as { ctx_metadata?: TrainingSalesMeta } | undefined)?.ctx_metadata?.brand_domain;
}

function accountRefFromCtx(account: unknown): ToolArgs['account'] | undefined {
  const acct = account as { id?: unknown; operator?: unknown; ctx_metadata?: TrainingSalesMeta } | undefined;
  const brandDomain = acct?.ctx_metadata?.brand_domain;
  const accountId = typeof acct?.id === 'string' && !acct.id.startsWith('synthetic_') && acct.id !== 'public_sandbox'
    ? acct.id
    : undefined;
  if (!accountId && !brandDomain) return undefined;
  return {
    ...(accountId && { account_id: accountId }),
    ...(brandDomain && { brand: { domain: brandDomain } }),
    ...(typeof acct?.ctx_metadata?.operator === 'string'
      ? { operator: acct.ctx_metadata.operator }
      : typeof acct?.operator === 'string'
        ? { operator: acct.operator }
        : {}),
  };
}

/**
 * v5 → v6 envelope translator. v5 handlers return `{ errors: [...] }` for
 * structured rejection; v6 platform methods throw `AdcpError`.
 */
function translateV5Result<T extends object>(result: unknown, options: { allowAdvisories?: boolean } = {}): T {
  const resultObj = result as (Record<string, unknown> & {
    errors?: Array<{
      code: string;
      message: string;
      field?: string;
      details?: unknown;
      recovery?: string;
    }>;
  } | undefined);
  const errs = resultObj?.errors;
  const hasAdvisorySuccessPayload = options.allowAdvisories === true && hasAdcpSuccessPayload(resultObj);
  if (Array.isArray(errs) && errs.length > 0 && !hasAdvisorySuccessPayload) {
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
  resolve: async (ref, ctx) => {
    const principal = ctx?.authInfo?.clientId;
    if (ref == null) {
      return {
        id: 'public_sandbox',
        name: 'Public Sandbox',
        status: 'active',
        mode: 'sandbox',
        ctx_metadata: {},
        sandbox: true,
        authInfo: { kind: 'public', ...(principal && { principal }) },
      };
    }
    const brandDomain =
      'brand' in ref && ref.brand && typeof ref.brand === 'object' && 'domain' in ref.brand
        ? (ref.brand.domain as string | undefined)
        : undefined;
    const accountId =
      'account_id' in ref && typeof ref.account_id === 'string' ? ref.account_id : undefined;
    const id = accountId ?? `synthetic_${brandDomain ?? 'anon'}`;
    const operator = 'operator' in ref && typeof ref.operator === 'string' ? ref.operator : undefined;
    return {
      id,
      name: brandDomain ?? id,
      status: 'active',
      mode: 'sandbox',
      ...(brandDomain != null && { brand: { domain: brandDomain } }),
      ...(operator && { operator }),
      ctx_metadata: { brand_domain: brandDomain, ...(operator && { operator }) },
      sandbox: true,
      authInfo: { kind: 'api_key', ...(principal && { principal }) },
    };
  },
  upsert: syncAccountsUpsert,
};

export class TrainingSalesPlatform
  implements DecisioningPlatform<TrainingSalesConfig, TrainingSalesMeta>
{
  constructor(private readonly storyboardCompat?: TrainingContext['storyboardCompat']) {}

  capabilities = TRAINING_SALES_CAPABILITIES;

  statusMappers = {};
  accounts: AccountStore<TrainingSalesMeta> = trainingSalesAccounts;
  agentRegistry = trainingBuyerAgentRegistry;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sales: SalesPlatform<TrainingSalesMeta> = {
    getProducts: async (req, ctx) => {
      const result = await handleGetProducts(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result, { allowAdvisories: true });
    },

    createMediaBuy: async (req, ctx) => {
      const v5Result = await handleCreateMediaBuy(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      // Detect the submitted-arm envelope the v5 handler returns when the
      // `force_create_media_buy_arm` test-controller directive is set.
      // The framework's projector rejects hand-rolled
      // `{ status: 'submitted', task_id }` shapes — the only path into
      // the submitted arm is `ctx.handoffToTask`. Pass the directive's
      // task_id through `TaskHandoffOptions.task_id` so the response
      // echoes the caller-supplied id (adcp-client#1554, SDK 6.11+).
      // The handoff fn throws because the test directive only asserts
      // on the immediate submitted envelope; no buyer polls completion
      // in this scenario, so the throw surfaces a clean error if anyone
      // ever does.
      if (
        v5Result &&
        typeof v5Result === 'object' &&
        (v5Result as { status?: unknown }).status === 'submitted' &&
        typeof (v5Result as { task_id?: unknown }).task_id === 'string'
      ) {
        const submitted = v5Result as { task_id: string; message?: string };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ctx.handoffToTask(
          async () => {
            throw new AdcpError('NOT_IMPLEMENTED', {
              recovery: 'terminal',
              message:
                'force_create_media_buy_arm directive issued the submitted envelope; ' +
                'the test directive does not register a completion handler.',
            });
          },
          { task_id: submitted.task_id },
        ) as any;
      }
      return translateV5Result(v5Result);
    },

    updateMediaBuy: async (buyId, patch, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      // brand placed after patch spread so it takes precedence over any brand
      // field the SDK might include in patch.
      const args = brandDomain
        ? { media_buy_id: buyId, ...(patch as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : { media_buy_id: buyId, ...(patch as unknown as Record<string, unknown>) };
      const v5Result = await handleUpdateMediaBuy(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(v5Result);
    },

    syncCreatives: async (creatives, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      // `dry_run` and `assignments[]` are dropped from the v6 typed
      // signature (adcp-client#1842). Lift them back off `ctx.input` so
      // the v5 handler honors dry-run mode and writes inline
      // package-binding side effects to session storage. The v6
      // response signature returns only `SyncCreativesRow[]`, so
      // `assignments[]` are observable via subsequent `get_media_buys`,
      // not in the sync_creatives response itself.
      const fromInput = pickFromInput(ctx.input, ['assignments', 'dry_run', 'account'] as const);
      const accountRef = (fromInput as { account?: ToolArgs['account'] }).account ?? accountRefFromCtx(ctx.account);
      const args = {
        creatives,
        ...fromInput,
        ...(accountRef && { account: accountRef }),
        ...(brandDomain && { brand: { domain: brandDomain } }),
      };
      const v5Result = await handleSyncCreatives(args as unknown as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      // v5 returns wire-wrapped `{ creatives: [...] }`; v6 SalesPlatform
      // wants rows directly — framework re-wraps.
      const wrapped = translateV5Result<{ creatives?: unknown[] }>(v5Result);
      return (wrapped.creatives ?? []) as Awaited<ReturnType<NonNullable<SalesPlatform['syncCreatives']>>>;
    },

    getMediaBuyDelivery: async (filter, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const args = brandDomain
        ? { ...(filter as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : filter;
      const result = await handleGetMediaBuyDelivery(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },

    // Optional read-side methods.
    getMediaBuys: async (req, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const args = brandDomain
        ? { ...(req as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : req;
      const result = await handleGetMediaBuys(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },

    listCreativeFormats: async (req, ctx) => {
      const result = await handleListCreativeFormats(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },

    listCreatives: async (req, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const args = brandDomain
        ? { ...(req as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : req;
      const result = await handleListCreatives(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },

    providePerformanceFeedback: async (req, ctx) => {
      const result = await handleProvidePerformanceFeedback(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },

    // sync_event_sources and log_event are required for event-kind
    // optimization goals (performance_buy_flow, event_dedup_flow). v5
    // handlers session-key off `account.brand.domain`; the v6 framework
    // strips account from req against the published schema, so thread
    // brand_domain back in from ctx.account.ctx_metadata.
    syncEventSources: async (req, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const args = brandDomain
        ? { ...(req as unknown as Record<string, unknown>), account: { brand: { domain: brandDomain } }, brand: { domain: brandDomain } }
        : req;
      const result = await handleSyncEventSources(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },

    logEvent: async (req, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const args = brandDomain
        ? { ...(req as unknown as Record<string, unknown>), account: { brand: { domain: brandDomain } }, brand: { domain: brandDomain } }
        : req;
      const result = await handleLogEvent(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },
  };

  // Audience-targeting capability is declared above; expose sync_audiences
  // so audience_buy_flow can register audiences before referencing them in
  // targeting_overlay. The training agent does not claim the audience-sync
  // specialism — this is the buy-side sibling, gated on audience_targeting
  // capability rather than on the audience-sync storyboard.
  audiences: AudiencePlatform<TrainingSalesMeta> = {
    syncAudiences: async (audienceList, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      // sync_audiences requires idempotency_key per schema. The framework
      // strips it from per-row params; synthesise one so the v5 handler's
      // shape validation passes. The v5 handler doesn't enforce uniqueness
      // here — the framework already handled idempotency upstream.
      const args = {
        audiences: audienceList,
        idempotency_key: `framework-projected-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...(brandDomain && { account: { brand: { domain: brandDomain } }, brand: { domain: brandDomain } }),
      };
      const result = await handleSyncAudiences(args as unknown as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      const wrapped = translateV5Result<{ audiences?: SyncAudiencesRow[] }>(result);
      return (wrapped.audiences ?? []) as SyncAudiencesRow[];
    },
    pollAudienceStatuses: async (_audienceIds, _ctx) => {
      // The training agent doesn't model long-running matching — every
      // audience resolves synchronously in syncAudiences. Return empty so
      // callers treat ids as not-yet-resolved; never throw here.
      return new Map<string, AudienceStatus>();
    },
  };
}
