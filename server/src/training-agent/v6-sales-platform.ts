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
  type LegacyMediaBuyHandlers,
  type AccountStore,
  type AudiencePlatform,
  type SyncAudiencesRow,
  type AudienceStatus,
} from '@adcp/sdk/server';
import {
  packageRefsForFormatOptions,
  projectV1ProductToV2,
} from '@adcp/sdk/v2/projection';
import {
  executeTrainingAgentTool,
  handleCreateMediaBuy,
  handleUpdateMediaBuy,
  handleGetMediaBuys,
  handleGetMediaBuyDelivery,
  handleSyncCreatives,
  handleListCreatives,
  handleListCreativeFormats,
  hasAdcpSuccessPayload,
  projectGetProductsCompatibilityWire,
  projectListCreativesCompatibilityWire,
  resolveServedAdcpVersion,
} from './task-handlers.js';
import {
  handleProvidePerformanceFeedback,
  handleSyncEventSources,
  handleLogEvent,
} from './catalog-event-handlers.js';
import { handleSyncAudiences } from './audience-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingSalesMeta {
  brand_domain?: string;
  operator?: string;
  account_ref?: ToolArgs['account'];
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
  requireOperatorAuth: false,
  supportedBillings: ['agent', 'operator'] as const,
  // Auto-derives `compliance_testing.scenarios[]` from the adapters wired in
  // `serverOptions.complyTest`. Empty block opts in; the capability/adapter
  // consistency check at construction throws if adapters aren't supplied.
  compliance_testing: {},
  config: { strict: false },
};

export function salesCapabilityProjection() {
  return {
    features: {
      inline_creative_management: true,
    },
    supported_optimization_metrics: [...TRAINING_SALES_CAPABILITIES.supported_optimization_metrics],
    vendor_metric_optimization: {
      supported_targets: [...TRAINING_SALES_CAPABILITIES.vendor_metric_optimization.supported_targets],
    },
  };
}

/** Build a TrainingContext from the v6 request context auth bridge. */
function buildTrainingCtx(
  ctx: {
    account?: unknown;
    authInfo?: { clientId?: string };
    agent?: { agent_url: string };
    input?: unknown;
  } | undefined,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): TrainingContext {
  const account = ctx?.account as { authInfo?: { principal?: string } } | undefined;
  const legacySessionBrandDomain = storyboardCompat?.version === '3.0'
    ? brandDomainFromCtx(ctx?.account)
    : undefined;
  const accountRef = accountRefFromCtx(ctx?.account, storyboardCompat);
  const resolvedAccount = accountRef && !accountRef.account_id
    ? {
      ...accountRef,
      ...((ctx?.account as { mode?: unknown } | undefined)?.mode === 'sandbox' && { sandbox: true }),
    }
    : accountRef;
  return {
    mode: 'open',
    tenantId: 'sales',
    principal: ctx?.authInfo?.clientId ?? account?.authInfo?.principal ?? 'anonymous',
    ...(ctx?.agent?.agent_url && { authenticatedAgentUrl: ctx.agent.agent_url }),
    ...(ctx?.input && typeof ctx.input === 'object' && !Array.isArray(ctx.input)
      ? { requestInput: ctx.input as Record<string, unknown> }
      : {}),
    ...(resolvedAccount && { resolvedAccount }),
    ...(legacySessionBrandDomain && { legacySessionBrandDomain }),
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

function accountRefFromCtx(
  account: unknown,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): ToolArgs['account'] | undefined {
  // The v6 framework removes the envelope account before invoking platform
  // methods. Frozen 3.0 storyboards and their controller steps historically
  // shared the remaining top-level brand session; re-injecting the resolved
  // account only on platform methods splits that compatibility-only flow.
  const acct = account as {
    id?: unknown;
    mode?: unknown;
    operator?: unknown;
    ctx_metadata?: TrainingSalesMeta;
  } | undefined;
  const originalRef = acct?.ctx_metadata?.account_ref;
  if (storyboardCompat?.version !== '3.0' && originalRef) return originalRef;
  const brandDomain = acct?.ctx_metadata?.brand_domain;
  const accountId = typeof acct?.id === 'string' && !acct.id.startsWith('synthetic_') && acct.id !== 'public_sandbox'
    ? acct.id
    : undefined;
  if (accountId) return { account_id: accountId };
  if (storyboardCompat?.version === '3.0') return undefined;
  if (!accountId && !brandDomain) return undefined;
  return {
    ...(brandDomain && { brand: { domain: brandDomain } }),
    ...(typeof acct?.ctx_metadata?.operator === 'string'
      ? { operator: acct.ctx_metadata.operator }
      : typeof acct?.operator === 'string'
        ? { operator: acct.operator }
        : {}),
    ...(acct?.mode === 'sandbox' && { sandbox: true }),
  };
}

function withResolvedAccountScope(
  input: Record<string, unknown>,
  account: unknown,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): ToolArgs {
  const { account: _legacyAccount, ...withoutAccount } = input;
  const base = storyboardCompat?.version === '3.0' ? withoutAccount : input;
  const accountRef = accountRefFromCtx(account, storyboardCompat);
  const brandDomain = brandDomainFromCtx(account);
  return {
    ...base,
    ...(accountRef && { account: accountRef }),
    ...(brandDomain && { brand: { domain: brandDomain } }),
  } as ToolArgs;
}

/** Preserve the SDK-13 natural-account session shape while restoring explicit
 * account_id references that the platform facade removes from domain args. */
function withCurrentAccountScope(
  input: Record<string, unknown>,
  account: unknown,
): ToolArgs {
  const accountRef = accountRefFromCtx(account);
  const brandDomain = brandDomainFromCtx(account);
  return {
    ...input,
    ...(accountRef && { account: accountRef }),
    ...(brandDomain && { brand: { domain: brandDomain } }),
  } as ToolArgs;
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

function throwGetProductsExecutionError(message: string): never {
  const validationMatch = message.match(/^Invalid get_products request(?: at ([^:]+))?:/);
  const invalidRequest = validationMatch !== null
    || message.includes('idempotency_key')
    || message.startsWith('brief must be a string');
  const code = message.includes('IDEMPOTENCY_CONFLICT')
    ? 'IDEMPOTENCY_CONFLICT'
    : message.includes('IDEMPOTENCY_EXPIRED')
      ? 'IDEMPOTENCY_EXPIRED'
      : message.includes('IDEMPOTENCY_IN_FLIGHT')
        ? 'IDEMPOTENCY_IN_FLIGHT'
        : message.includes('RATE_LIMITED')
          ? 'RATE_LIMITED'
          : invalidRequest
            ? 'INVALID_REQUEST'
            : 'SERVICE_UNAVAILABLE';
  const field = validationMatch?.[1]
    ?? (message.startsWith('brief must be a string') ? 'brief' : undefined)
    ?? (message.includes('idempotency_key') ? 'idempotency_key' : undefined);
  const retryAfterMatch = message.match(/retry_after=(\d+)/);
  throw new AdcpError(code, {
    recovery: code === 'RATE_LIMITED' || code === 'IDEMPOTENCY_IN_FLIGHT' || code === 'SERVICE_UNAVAILABLE'
      ? 'transient'
      : 'correctable',
    message,
    ...(code === 'INVALID_REQUEST' && field && { field }),
    ...(retryAfterMatch && { retry_after: Number(retryAfterMatch[1]) }),
  });
}

/** The DecisioningPlatform contract is canonical even when the outer SDK
 * negotiates a legacy wire. Keep legacy selector echo metadata in our state,
 * but let the SDK reconstruct the 3.0 response from stable canonical refs.
 * Remove this adapter when adcontextprotocol/adcp-client#2497 ships. */
function canonicalMediaBuyPlatformResult<T>(result: T): T {
  const withoutLegacyPackageSelector = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const {
      format_ids: _legacyFormatIds,
      __selected_legacy_format_ids: _selectedLegacyFormatIds,
      ...canonical
    } = value as Record<string, unknown>;
    const legacyFormatIds = Array.isArray(_legacyFormatIds) ? _legacyFormatIds : [];
    const selectedLegacyFormatIds = Array.isArray(_selectedLegacyFormatIds)
      ? _selectedLegacyFormatIds
      : legacyFormatIds;
    if (
      selectedLegacyFormatIds.length > 0
      && (!Array.isArray(canonical.format_option_refs) || canonical.format_option_refs.length === 0)
    ) {
      const productId = typeof canonical.product_id === 'string'
        ? canonical.product_id
        : 'legacy_package_projection';
      const projected = projectV1ProductToV2({
        product_id: productId,
        name: productId,
        description: 'Ephemeral native-platform legacy package projection',
        format_ids: selectedLegacyFormatIds as Parameters<typeof projectV1ProductToV2>[0]['format_ids'],
      });
      const options = projected.v2.format_options ?? [];
      const optionIds = options.flatMap(option =>
        typeof option.format_option_id === 'string' ? [option.format_option_id] : []
      );
      if (projected.diagnostics.length === 0 && optionIds.length === selectedLegacyFormatIds.length) {
        return {
          ...canonical,
          ...packageRefsForFormatOptions(
            projected.v2 as unknown as Parameters<typeof packageRefsForFormatOptions>[0],
            optionIds,
          ),
          ...(!Array.isArray(canonical.formats_to_provide) && { formats_to_provide: options }),
        };
      }
    }
    return canonical;
  };
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const next = { ...record };
  if (Array.isArray(record.packages)) {
    next.packages = record.packages.map(withoutLegacyPackageSelector);
  }
  if (Array.isArray(record.affected_packages)) {
    next.affected_packages = record.affected_packages.map(withoutLegacyPackageSelector);
  }
  if (Array.isArray(record.media_buys)) {
    next.media_buys = record.media_buys.map(mediaBuy => {
      if (!mediaBuy || typeof mediaBuy !== 'object' || Array.isArray(mediaBuy)) return mediaBuy;
      const buy = mediaBuy as Record<string, unknown>;
      return {
        ...buy,
        ...(Array.isArray(buy.packages) && {
          packages: buy.packages.map(withoutLegacyPackageSelector),
        }),
      };
    });
  }
  return next as T;
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
      ctx_metadata: {
        account_ref: ref as ToolArgs['account'],
        brand_domain: brandDomain,
        ...(operator && { operator }),
      },
      sandbox: true,
      authInfo: { kind: 'api_key', ...(principal && { principal }) },
    };
  },
  upsert: syncAccountsUpsert,
};

/**
 * Resolve the trusted sales account and buyer-agent context for native MCP
 * dispatchers that sit beside the SDK facade. Keeping this on the platform's
 * actual resolvers prevents the split 3.2 tools from treating buyer input as
 * an already-authorized account.
 */
export async function resolveTrainingSalesRequestContext(
  input: Record<string, unknown>,
  auth: {
    clientId?: string;
    scopes?: string[];
    extra?: Record<string, unknown>;
  } | undefined,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): Promise<TrainingContext> {
  const credential = auth?.extra?.credential;
  const agent = await trainingBuyerAgentRegistry.resolve({
    ...(credential ? { credential: credential as never } : {}),
    ...(auth?.extra && { extra: auth.extra }),
    input,
  });
  const account = await trainingSalesAccounts.resolve(
    input.account as never,
    {
      authInfo: {
        ...(auth?.clientId && { clientId: auth.clientId }),
        ...(auth?.scopes && { scopes: auth.scopes }),
        ...(credential ? { credential: credential as never } : {}),
        ...(auth?.extra && { extra: auth.extra }),
      },
      toolName: 'get_products',
      ...(agent && { agent }),
      input,
    },
  );
  if (!account) throw new Error('Unable to resolve sales account');
  return buildTrainingCtx({
    account,
    authInfo: { clientId: auth?.clientId },
    ...(agent && { agent }),
    input,
  }, storyboardCompat);
}

/**
 * Temporary raw-wire compatibility adapters for creative identity surfaces.
 *
 * AdCP 3.1's canonical-format conformance scenarios deliberately exercise
 * the migration-window dual shape (legacy + canonical creative identities). The SDK
 * v13 DecisioningPlatform facade canonicalizes platform results and then
 * emits exactly one creative wire representation and does not retain the full
 * legacy route across persistence. Keep these handlers isolated on the SDK's
 * explicit legacy seam until the upstream facade exposes a durable projection
 * route and the 3.1 scenarios negotiate canonical and legacy views separately.
 */
export function legacyGetProductsHandler(
  storyboardCompat?: TrainingContext['storyboardCompat'],
): NonNullable<LegacyMediaBuyHandlers['getProducts']> {
  return async (req, ctx) => {
    const normalizedReq = withResolvedAccountScope(
      req as unknown as Record<string, unknown>,
      ctx.account,
      storyboardCompat,
    );
    const versionResolution = resolveServedAdcpVersion(normalizedReq as unknown as Record<string, unknown>);
    const trainingCtx = buildTrainingCtx(ctx, storyboardCompat);
    if (versionResolution.ok) trainingCtx.servedAdcpVersion = versionResolution.servedVersion;
    const executed = await executeTrainingAgentTool('get_products', normalizedReq, trainingCtx);
    if (!executed.success) throwGetProductsExecutionError(executed.error ?? 'get_products failed');
    const response = translateV5Result<{ products?: import('@adcp/sdk').LegacyProduct[] }>(
      executed.data,
      { allowAdvisories: true },
    );
    return projectGetProductsCompatibilityWire(
      response,
      req as unknown as Record<string, unknown>,
    ) as Awaited<ReturnType<NonNullable<LegacyMediaBuyHandlers['getProducts']>>>;
  };
}

export function legacySyncCreativesHandler(
  storyboardCompat?: TrainingContext['storyboardCompat'],
): NonNullable<LegacyMediaBuyHandlers['syncCreatives']> {
  return async (req, ctx) => {
    return await handleSyncCreatives(
      req as unknown as ToolArgs,
      buildTrainingCtx(ctx, storyboardCompat),
    ) as unknown as Awaited<ReturnType<NonNullable<LegacyMediaBuyHandlers['syncCreatives']>>>;
  };
}

export function legacyListCreativesHandler(
  storyboardCompat?: TrainingContext['storyboardCompat'],
): NonNullable<LegacyMediaBuyHandlers['listCreatives']> {
  return async (req, ctx) => {
    const response = await handleListCreatives(
      req as ToolArgs,
      buildTrainingCtx(ctx, storyboardCompat),
    );
    return projectListCreativesCompatibilityWire(
      response as { creatives?: Array<Record<string, unknown>>; errors?: unknown[] },
      req as unknown as Record<string, unknown>,
    ) as unknown as Awaited<ReturnType<NonNullable<LegacyMediaBuyHandlers['listCreatives']>>>;
  };
}

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
    createMediaBuy: async (req, ctx) => {
      const args = this.storyboardCompat?.version === '3.0'
        ? withResolvedAccountScope(
          req as unknown as Record<string, unknown>,
          ctx.account,
          this.storyboardCompat,
        )
        : withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account);
      const v5Result = await handleCreateMediaBuy(args, buildTrainingCtx(ctx, this.storyboardCompat));
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
      return translateV5Result(canonicalMediaBuyPlatformResult(v5Result));
    },

    updateMediaBuy: async (buyId, patch, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const currentArgs = brandDomain
        ? { media_buy_id: buyId, ...(patch as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : { media_buy_id: buyId, ...(patch as unknown as Record<string, unknown>) };
      const args = this.storyboardCompat?.version === '3.0'
        ? withResolvedAccountScope(currentArgs, ctx.account, this.storyboardCompat)
        : withCurrentAccountScope(currentArgs, ctx.account);
      const v5Result = await handleUpdateMediaBuy(args, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(canonicalMediaBuyPlatformResult(v5Result));
    },

    getMediaBuyDelivery: async (filter, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const currentArgs = brandDomain
        ? { ...(filter as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : filter;
      const args = this.storyboardCompat?.version === '3.0'
        ? withResolvedAccountScope(
          filter as unknown as Record<string, unknown>,
          ctx.account,
          this.storyboardCompat,
        )
        : withCurrentAccountScope(currentArgs as Record<string, unknown>, ctx.account);
      const result = await handleGetMediaBuyDelivery(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },

    // Optional read-side methods.
    getMediaBuys: async (req, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const currentArgs = brandDomain
        ? { ...(req as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : req;
      const args = this.storyboardCompat?.version === '3.0'
        ? withResolvedAccountScope(
          req as unknown as Record<string, unknown>,
          ctx.account,
          this.storyboardCompat,
        )
        : withCurrentAccountScope(currentArgs as Record<string, unknown>, ctx.account);
      const result = await handleGetMediaBuys(args as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(canonicalMediaBuyPlatformResult(result));
    },

    listCreativeFormatsLegacy: async (req, ctx) => {
      const result = await handleListCreativeFormats(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
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
  } as SalesPlatform<TrainingSalesMeta>;

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
