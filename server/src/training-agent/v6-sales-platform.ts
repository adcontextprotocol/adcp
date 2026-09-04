/**
 * v6 SalesPlatform for the `/sales` tenant.
 *
 * Sales platform claiming `sales-non-guaranteed`, `sales-guaranteed`, and
 * `sales-dooh`. Implements `SalesPlatform` (5 required methods +
 * 4 optional read-side methods).
 *
 * Spike-grade port: bodies shim through to existing v5 handlers via
 * `translateV5Result`. Same approach as `/signals` — validates framework
 * wiring against the storyboard suite first; native porting (handler
 * bodies that throw `AdcpError` directly) is a follow-up.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import {
  AdcpError,
  type DecisioningPlatform,
  type SalesPlatform,
  type MediaBuyLifecyclePlatform,
  type LegacyMediaBuyHandlers,
  type AccountStore,
  type AudiencePlatform,
  type SyncAudiencesRow,
  type AudienceStatus,
  type CreateMediaBuyHandlerResult,
  type TaskRegistry,
  type TaskRegistryScope,
  type WebhookEmitParams,
} from '@adcp/sdk/server';
import {
  packageRefsForFormatOptions,
  projectV1ProductToV2,
} from '@adcp/sdk/v2/projection';
import {
  executeTrainingAgentTool,
  executeProductDiscoveryPlatformTool,
  handleBuyProducts,
  handleAcceptProposal,
  handleControlMediaBuy,
  isSellerManagedControlTaskRequired,
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
import { PUBLISHERS } from './publishers.js';
import { waitForForcedTaskCompletion } from './comply-test-controller.js';
import { proposalCapabilitiesForProfile } from './proposal-negotiation-profiles.js';
import { buildCatalog } from './product-factory.js';
import {
  getReportingStatusForAccountDurably,
  reportingStatusUnavailable,
  resolveReportingAccountDurably,
  syncReliableReportingReceiptsForAccount,
  TRAINING_REPORTING_CORE_OFFERING,
  TRAINING_REPORTING_MANAGED_OFFERING,
  TRAINING_REPORTING_RECONCILED_OFFERING,
  validateReliableReportingResponse,
  withDurableReportingLedger,
} from './reporting-reliability.js';
import { getSession, registerSharedPublicBrandPartition, runWithSessionContext, sessionKeyFromArgs } from './state.js';
import { atLeastAdcpVersion, REPORTING_STATUS_ADCP_VERSION, type ToolArgs, type TrainingContext } from './types.js';
import { canonicalizeAccountRef, syntheticAccountIdFromRef } from './account-scope.js';
import { emitDurableSellerManagedTaskWebhook, maybeEmitCompletionWebhook } from './webhooks.js';
import { validateWebhookUrl } from './webhook-fetch.js';
import {
  taskRegistryNamespaceForTenant,
  taskRegistryScopeFromContext,
} from './task-registry-scope.js';
import { scopedPrincipal } from './idempotency.js';
import {
  SellerManagedControlJobCoordinator,
  type SellerManagedControlJobContext,
} from './seller-managed-control-jobs.js';

const logger = createLogger('training-agent-v6-sales-platform');

const PUSH_NOTIFICATION_TOKEN_MIN_LENGTH = 16;
const PUSH_NOTIFICATION_TOKEN_MAX_LENGTH = 4096;
const PUSH_NOTIFICATION_TOKEN_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const PUSH_NOTIFICATION_OPERATION_ID_RE = /^[A-Za-z0-9_.:-]{1,255}$/;

interface AsyncGetProductsPushConfig {
  url: string;
  operationId: string;
  token?: string;
}

type AsyncGetProductsTaskError = {
  code: 'SERVICE_UNAVAILABLE';
  recovery: 'transient';
  message: string;
};

function invalidPushNotificationConfig(field: string, message: string): never {
  throw new AdcpError('INVALID_REQUEST', {
    recovery: 'correctable',
    field: `push_notification_config.${field}`,
    message,
  });
}

/**
 * The SDK's canonical decisioning path validates push registrations before it
 * creates a task. The legacy get_products seam must preserve that admission
 * boundary because it allocates the task itself after observing Submitted.
 */
export async function validateAsyncGetProductsPushConfig(
  rawConfig: unknown,
): Promise<AsyncGetProductsPushConfig | undefined> {
  if (rawConfig === undefined) return undefined;
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    invalidPushNotificationConfig('url', 'push_notification_config must be an object');
  }
  const config = rawConfig as Record<string, unknown>;
  if (typeof config.url !== 'string' || config.url.length === 0) {
    invalidPushNotificationConfig('url', 'push_notification_config.url is required');
  }
  const urlError = await validateWebhookUrl(config.url, { allowLoopback: true });
  if (urlError) {
    invalidPushNotificationConfig('url', urlError.message);
  }
  if (typeof config.operation_id !== 'string' || config.operation_id.length === 0) {
    invalidPushNotificationConfig(
      'operation_id',
      'push_notification_config.operation_id is required for webhook delivery',
    );
  }
  if (!PUSH_NOTIFICATION_OPERATION_ID_RE.test(config.operation_id)) {
    invalidPushNotificationConfig(
      'operation_id',
      `push_notification_config.operation_id must match ${PUSH_NOTIFICATION_OPERATION_ID_RE.source}`,
    );
  }

  let token: string | undefined;
  if (config.token !== undefined) {
    if (typeof config.token !== 'string') {
      invalidPushNotificationConfig('token', 'push_notification_config.token must be a string');
    }
    if (config.token.length < PUSH_NOTIFICATION_TOKEN_MIN_LENGTH) {
      invalidPushNotificationConfig(
        'token',
        `push_notification_config.token must contain at least ${PUSH_NOTIFICATION_TOKEN_MIN_LENGTH} characters`,
      );
    }
    if (config.token.length > PUSH_NOTIFICATION_TOKEN_MAX_LENGTH) {
      invalidPushNotificationConfig(
        'token',
        `push_notification_config.token must contain at most ${PUSH_NOTIFICATION_TOKEN_MAX_LENGTH} characters`,
      );
    }
    if (PUSH_NOTIFICATION_TOKEN_CONTROL_CHAR_RE.test(config.token)) {
      invalidPushNotificationConfig('token', 'push_notification_config.token must not contain control characters');
    }
    token = config.token;
  }

  return {
    url: config.url,
    operationId: config.operation_id,
    ...(token !== undefined && { token }),
  };
}

async function emitAsyncGetProductsTerminalWebhook(opts: {
  accountId: string;
  taskId: string;
  pushConfig?: AsyncGetProductsPushConfig;
  emitWebhook?: (params: WebhookEmitParams) => Promise<unknown>;
  status: 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: AsyncGetProductsTaskError;
}): Promise<void> {
  if (!opts.pushConfig || !opts.emitWebhook) return;
  const payload: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    operation_id: opts.pushConfig.operationId,
    task_id: opts.taskId,
    task_type: 'get_products',
    protocol: 'media-buy',
    status: opts.status,
    timestamp: new Date().toISOString(),
    ...(opts.pushConfig.token !== undefined && { token: opts.pushConfig.token }),
  };
  if (opts.status === 'completed' && opts.result) {
    payload.result = opts.result;
  } else if (opts.status === 'failed' && opts.error) {
    payload.result = { errors: [opts.error] };
    payload.message = opts.error.message;
  }
  try {
    await opts.emitWebhook({
      url: opts.pushConfig.url,
      delivery_id: `get_products.${opts.accountId}.${opts.taskId}.${opts.status}`,
      payload,
    });
  } catch (error) {
    // Task persistence is authoritative. Delivery owns independent retry and
    // recovery and must never mutate or reject the already-terminal task.
    logger.warn({ err: error, taskId: opts.taskId, status: opts.status }, 'Async get_products terminal webhook failed');
  }
}

export async function settleAsyncGetProductsTask(opts: {
  accountId: string;
  taskId: string;
  taskRef: TaskRegistryScope;
  taskRegistry: TaskRegistry;
  completionScope: Parameters<typeof waitForForcedTaskCompletion>[1];
  pushConfig?: AsyncGetProductsPushConfig;
  emitWebhook?: (params: WebhookEmitParams) => Promise<unknown>;
  waitForCompletion?: typeof waitForForcedTaskCompletion;
}): Promise<void> {
  const waitForCompletion = opts.waitForCompletion ?? waitForForcedTaskCompletion;
  let result: Record<string, unknown>;
  try {
    result = await waitForCompletion(opts.taskId, opts.completionScope);
    await opts.taskRegistry.complete(opts.taskId, opts.taskRef, result);
  } catch (error) {
    const taskError: AsyncGetProductsTaskError = {
      code: 'SERVICE_UNAVAILABLE',
      recovery: 'transient',
      message: error instanceof Error ? error.message : 'Async get_products failed',
    };
    await opts.taskRegistry.fail(opts.taskId, opts.taskRef, taskError, { errors: [taskError] });
    await emitAsyncGetProductsTerminalWebhook({
      ...opts,
      status: 'failed',
      error: taskError,
    });
    return;
  }
  await emitAsyncGetProductsTerminalWebhook({
    ...opts,
    status: 'completed',
    result,
  });
}

interface TrainingSalesMeta {
  brand_domain?: string;
  operator?: string;
  account_ref?: ToolArgs['account'];
  task_owner_scope?: string;
  webhook_tenant_scope?: string;
  [key: string]: unknown;
}

interface TrainingSalesConfig {
  strict: boolean;
}

interface TaskOwnerRequestContext {
  sessionKey?: string;
  callerMutationScope?: Readonly<{ tenant_id: string; principal_id: string; account_id?: string }>;
  agent?: { agent_url?: string };
  authInfo?: {
    clientId?: string;
    credential?:
      | { kind: 'http_sig'; agent_url: string }
      | { kind: 'oauth'; client_id: string }
      | { kind: 'api_key'; key_id: string };
  };
}

function authenticatedPrincipalForPlatformContext(ctx: TaskOwnerRequestContext): string | undefined {
  if (ctx.agent?.agent_url) return `agent:${ctx.agent.agent_url}`;
  const credential = ctx.authInfo?.credential;
  if (credential?.kind === 'http_sig') return `http_sig:${credential.agent_url}`;
  if (credential?.kind === 'oauth') return `oauth:${credential.client_id}`;
  if (credential?.kind === 'api_key') return `api_key:${credential.key_id}`;
  return ctx.authInfo?.clientId ? `client:${ctx.authInfo.clientId}` : undefined;
}

/** Byte-for-byte equivalent of the SDK webhook delivery partition that is
 * bound on the outer HandlerContext before dispatchCompactMutation adds its
 * callerMutationScope to the platform-only request context. */
export function webhookTenantScopeForPlatformContext(
  ctx: TaskOwnerRequestContext & { account?: unknown },
): string | undefined {
  // RequestContext intentionally omits transport auth/session fields. Capture
  // the SDK's exact outer webhook partition in AccountStore.resolve(), where
  // those trusted fields are still present, and carry it through metadata.
  const captured = (ctx.account as { ctx_metadata?: TrainingSalesMeta } | undefined)
    ?.ctx_metadata?.webhook_tenant_scope;
  if (captured !== undefined) return captured;

  const account = ctx.account as {
    id?: unknown; account_id?: unknown; tenant_id?: unknown; tenantId?: unknown;
  } | undefined;
  const accountId = typeof account?.id === 'string' ? account.id
    : typeof account?.account_id === 'string' ? account.account_id : undefined;
  const tenantId = typeof account?.tenant_id === 'string' ? account.tenant_id
    : typeof account?.tenantId === 'string' ? account.tenantId : undefined;
  const principal = authenticatedPrincipalForPlatformContext(ctx);
  if (ctx.sessionKey !== undefined) {
    return JSON.stringify(['session', ctx.sessionKey, tenantId ?? null, accountId ?? null, principal ?? null]);
  }
  if (tenantId !== undefined || accountId !== undefined) {
    return JSON.stringify(['account', tenantId ?? null, accountId ?? null, principal ?? null]);
  }
  return principal !== undefined ? JSON.stringify(['principal', principal]) : undefined;
}

/** Keep the outbox partition identical to the SDK task registry partition. */
function taskOwnerScopeForRequest(ctx: TaskOwnerRequestContext, accountId: string): string {
  if (ctx.sessionKey !== undefined) return `session:${ctx.sessionKey}`;
  if (ctx.agent?.agent_url) return `agent:${ctx.agent.agent_url}`;
  const credential = ctx.authInfo?.credential;
  if (credential?.kind === 'http_sig') return `http_sig:${credential.agent_url}`;
  if (credential?.kind === 'oauth') return `oauth:${credential.client_id}`;
  if (credential?.kind === 'api_key') return `api_key:${credential.key_id}`;
  if (ctx.authInfo?.clientId) return `client:${ctx.authInfo.clientId}`;
  return `account:${accountId}`;
}

export function taskOwnerScopeForPlatformContext(
  ctx: TaskOwnerRequestContext & { account?: unknown },
  accountId: string,
): string {
  // AccountStore captures the SDK task partition from the original transport
  // context. Preserve it exactly: in particular, session scope takes
  // precedence over a subsequently resolved buyer-agent identity.
  const captured = (ctx.account as { ctx_metadata?: TrainingSalesMeta } | undefined)
    ?.ctx_metadata?.task_owner_scope;
  return captured ?? taskOwnerScopeForRequest(ctx, accountId);
}

function idempotencyPrincipalForPlatformContext(
  ctx: TaskOwnerRequestContext & { account?: unknown },
  accountRef: ToolArgs['account'],
): string {
  const account = ctx.account as { authInfo?: { principal?: unknown } } | undefined;
  const principal = ctx.authInfo?.clientId ?? account?.authInfo?.principal;
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new AdcpError('AUTH_MISSING', {
      recovery: 'correctable',
      message: 'Seller-managed control requires an authenticated principal.',
    });
  }
  if (principal !== 'static:public' && principal !== 'static:public:shared') return principal;
  const accountScope = typeof accountRef?.account_id === 'string'
    ? `a:${accountRef.account_id}`
    : typeof accountRef?.brand?.domain === 'string'
      ? `b:${accountRef.brand.domain.toLowerCase()}`
      : undefined;
  return scopedPrincipal(principal, accountScope);
}

const PACKAGE_SELECTOR_FIELDS = [
  'format_option_refs',
  'format_kind',
  'params',
  'format_ids',
] as const;

/**
 * The SDK's canonical platform signature intentionally omits deprecated
 * selector fields. During the 3.x compatibility window we still need the raw
 * co-present routes so the receiver can resolve and equivalence-check them
 * before canonical precedence is applied.
 */
export function restoreRawPackageSelectors(
  normalized: Record<string, unknown>,
  rawInput: unknown,
  packageFields: readonly string[],
): Record<string, unknown> {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return normalized;
  const rawRecord = rawInput as Record<string, unknown>;
  const restored = { ...normalized };
  for (const packageField of packageFields) {
    const normalizedPackages = normalized[packageField];
    const rawPackages = rawRecord[packageField];
    if (!Array.isArray(normalizedPackages) || !Array.isArray(rawPackages)) continue;
    restored[packageField] = normalizedPackages.map((pkg, index) => {
      const rawPackage = rawPackages[index];
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)
        || !rawPackage || typeof rawPackage !== 'object' || Array.isArray(rawPackage)) {
        return pkg;
      }
      const next = { ...(pkg as Record<string, unknown>) };
      for (const selectorField of PACKAGE_SELECTOR_FIELDS) {
        if (selectorField in rawPackage) {
          next[selectorField] = (rawPackage as Record<string, unknown>)[selectorField];
        }
      }
      return next;
    });
  }
  return restored;
}

// The in-repo schema adds this value before the published SDK's generated
// AdCPSpecialism union can include it. Keep the cast at this single boundary;
// the wire value remains the literal `sales-dooh` and is schema-tested here.
const SALES_DOOH_SPECIALISM = 'sales-dooh' as never;

const TRAINING_SALES_CHANNELS = [
  'display',
  'olv',
  'ctv',
  'email',
  'streaming_audio',
  'podcast',
  'dooh',
  'ooh',
  'gaming',
  'retail_media',
  'linear_tv',
  'social',
  'influencer',
  'search',
  'radio',
  'print',
] as const;

export const TRAINING_SALES_CAPABILITIES = {
  specialisms: ['sales-non-guaranteed', 'sales-guaranteed', SALES_DOOH_SPECIALISM] as const,
  creative_agents: [],
  channels: TRAINING_SALES_CHANNELS,
  overrides: {
    media_buy: {
      portfolio: {
        publisher_domains: PUBLISHERS.map(publisher => publisher.domain),
        primary_channels: [...TRAINING_SALES_CHANNELS],
      },
      reporting_delivery: {
        supported: true as const,
        reliable_reporting_version: '1.0' as const,
        managed_delivery: true as const,
        reconciled_billing: true as const,
        configuration_task: 'sync_accounts' as const,
        status_task: 'get_reporting_status' as const,
        receipt_task: 'sync_reporting_receipts' as const,
        offerings: [
          TRAINING_REPORTING_CORE_OFFERING,
          TRAINING_REPORTING_MANAGED_OFFERING,
          TRAINING_REPORTING_RECONCILED_OFFERING,
        ] as [
          typeof TRAINING_REPORTING_CORE_OFFERING,
          typeof TRAINING_REPORTING_MANAGED_OFFERING,
          typeof TRAINING_REPORTING_RECONCILED_OFFERING,
        ],
        automated_recovery_window_seconds: 7200,
        status_retention_days: 31,
        resource_retention_days: 31,
        authorization_revocation_seconds: 60,
      },
    },
    experimental_features: ['media_buy.reporting_delivery'],
  },
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
  // Seller-level rollup of metric-optimization capabilities. The SDK can
  // derive this from an adopter-supplied static productCatalog (#1818); this
  // training platform resolves products dynamically, so it declares the
  // honest union explicitly and the tenant router preserves that declaration.
  supported_optimization_metrics: ['clicks' as const, 'views' as const, 'completed_views' as const, 'engagements' as const, 'reach' as const],
  vendor_metric_optimization: {
    supported_targets: ['threshold_rate' as const],
  },
  performance_feedback: {
    reports_application_status: true,
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
    performance_feedback: {
      ...TRAINING_SALES_CAPABILITIES.performance_feedback,
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
    servedAdcpVersion?: string;
    callerMutationScope?: Readonly<{ tenant_id: string; principal_id: string; account_id?: string }>;
    proposalRefinementScope?: Readonly<{ tenant_id: string; principal_id: string; account_id?: string }>;
  } | undefined,
  storyboardCompat?: TrainingContext['storyboardCompat'],
  proposalNegotiationProfile?: TrainingContext['proposalNegotiationProfile'],
): TrainingContext {
  const account = ctx?.account as { authInfo?: { principal?: string } } | undefined;
  const requestInput = ctx?.input && typeof ctx.input === 'object' && !Array.isArray(ctx.input)
    ? ctx.input as Record<string, unknown>
    : undefined;
  const carriesVersionEnvelope = requestInput !== undefined
    && (requestInput.adcp_version !== undefined || requestInput.adcp_major_version !== undefined);
  const requestVersion = carriesVersionEnvelope ? resolveServedAdcpVersion(requestInput) : undefined;
  const servedAdcpVersion = ctx?.servedAdcpVersion
    ?? (requestVersion?.ok ? requestVersion.servedVersion : undefined);
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
    ...(requestInput && { requestInput }),
    ...(servedAdcpVersion && { servedAdcpVersion }),
    ...(resolvedAccount && { resolvedAccount }),
    ...(typeof (ctx?.account as { id?: unknown } | undefined)?.id === 'string'
      && { resolvedAccountId: (ctx!.account as { id: string }).id }),
    ...(legacySessionBrandDomain && { legacySessionBrandDomain }),
    ...(storyboardCompat && { storyboardCompat }),
    ...(ctx?.callerMutationScope && { callerMutationScope: ctx.callerMutationScope }),
    ...(ctx?.proposalRefinementScope && { proposalRefinementScope: ctx.proposalRefinementScope }),
    ...(proposalNegotiationProfile && { proposalNegotiationProfile }),
  };
}

/**
 * Derive the delivery partition for synchronous compatibility webhooks from
 * framework-resolved state only. Request fields are buyer-controlled and must
 * never select another caller's durable webhook namespace.
 */
function trustedWebhookPrincipal(ctx: {
  account?: unknown;
  authInfo?: { clientId?: string };
  callerMutationScope?: Readonly<{ tenant_id: string; principal_id: string; account_id?: string }>;
}): string {
  const scope = ctx.callerMutationScope;
  if (scope) {
    return JSON.stringify([
      'caller',
      scope.tenant_id,
      scope.principal_id,
      scope.account_id ?? null,
    ]);
  }
  const account = ctx.account as {
    id?: unknown;
    authInfo?: { principal?: unknown };
    ctx_metadata?: { account_ref?: unknown };
  } | undefined;
  const accountId = account?.id;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('create_media_buy completion webhook requires a framework-resolved caller or account scope');
  }
  // RequestContext currently omits authInfo, but the trusted AccountStore
  // projection retains the authenticated principal on the resolved account.
  // Prefer a future first-class bridge when available and keep the account
  // boundary in both cases. This mirrors the registry's scoped-principal
  // delimiter and prevents two authenticated buyers using the same request
  // key against one account from sharing a webhook delivery identity.
  const authenticatedPrincipal = ctx.authInfo?.clientId ?? account?.authInfo?.principal;
  if (typeof authenticatedPrincipal !== 'string' || authenticatedPrincipal.length === 0) {
    throw new Error('create_media_buy completion webhook requires an authenticated principal');
  }
  if (authenticatedPrincipal === 'static:public' || authenticatedPrincipal === 'static:public:shared') {
    const ref = account?.ctx_metadata?.account_ref as {
      account_id?: unknown;
      brand?: { domain?: unknown };
    } | undefined;
    const publicAccountScope = typeof ref?.account_id === 'string'
      ? `a:${ref.account_id}`
      : typeof ref?.brand?.domain === 'string'
        ? `b:${ref.brand.domain.toLowerCase()}`
        : `a:${accountId}`;
    return scopedPrincipal(authenticatedPrincipal, publicAccountScope);
  }
  return scopedPrincipal(authenticatedPrincipal, `a:${accountId}`);
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
  rawInput?: unknown,
): ToolArgs {
  const rawFields = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown>
    : {};
  const accountRef = accountRefFromCtx(account);
  const brandDomain = brandDomainFromCtx(account);
  const principal = (account as { authInfo?: { principal?: unknown } } | undefined)?.authInfo?.principal;
  const rawAccount = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? (rawInput as Record<string, unknown>).account
    : undefined;
  const explicitlySandboxed = rawAccount !== null
    && typeof rawAccount === 'object'
    && !Array.isArray(rawAccount)
    && (rawAccount as Record<string, unknown>).sandbox === true;
  const scopedArgs = {
    // `mcpToolProfile: 'all'` exposes compatibility schemas as shallow key
    // hints. Restore the raw wire values before the local source-schema
    // validator runs. Explicit wire values win over framework defaults, while
    // the normalized account and brand below remain authoritative.
    ...input,
    ...rawFields,
    ...(accountRef && { account: accountRef }),
    ...(brandDomain && { brand: { domain: brandDomain } }),
  } as ToolArgs;
  // Public training credentials share the controller's brand-owned task
  // partition, but the truthful sandbox/operator AccountRef remains intact for
  // persistence and authorization comparisons.
  return explicitlySandboxed
    && typeof principal === 'string'
    && principal.startsWith('static:')
    && accountRef?.brand?.domain
    ? registerSharedPublicBrandPartition(scopedArgs, accountRef.brand.domain)
    : scopedArgs;
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
 * v5 → v6 boundary for tasks whose response schema shares
 * media-buy-commitment-response.json's status-discriminated "Commitment
 * Error" arm (buy_products today; accept_proposal/control_media_buy share
 * the same schema but aren't wired through this path yet).
 *
 * translateV5Result throws an AdcpError for a v5 `{ errors: [...] }` result,
 * which the SDK's create-adcp-server rebuilds into a single `adcp_error`
 * envelope — that shape has no `errors[]` array and fails this response
 * schema's `required: ["status", "errors"]` "Commitment Error" arm. The
 * SDK's own `isErrorArm`/`wrapErrorArm` recognize the v5 handler's bare
 * `{ errors, ...context }` result directly (no `status` key — its presence
 * is what disqualifies the isErrorArm match) and correctly synthesize
 * `status: "failed"` plus a preserved `errors[]` on the wire, so this
 * returns that bare shape unchanged instead of routing it through the throw.
 */
function translateV5CommitmentResult<T extends object>(result: unknown): T {
  const resultObj = result as (Record<string, unknown> & { errors?: unknown[] }) | undefined;
  if (Array.isArray(resultObj?.errors) && resultObj.errors.length > 0) {
    return resultObj as T;
  }
  return translateV5Result<T>(result);
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
 * adcontextprotocol/adcp-client#2497 added a raw lifecycle-handler escape
 * hatch; remove this adapter only after create/update/get media-buy legacy
 * handlers use that seam. */
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
 * Mirror the SDK's AdCP 3.0 create-media-buy response projection for the
 * compatibility completion webhook. The platform consumes a canonical result,
 * then the framework restores the selected legacy format tuple on the wire and
 * adds the synchronous terminal status. Webhook `result` must be identical to
 * that buyer-visible response, not either intermediate representation.
 */
function projectCreateMediaBuyCompatibilityWebhookResult(
  legacyResult: Record<string, unknown>,
  canonicalResult: Record<string, unknown>,
): Record<string, unknown> {
  const legacyPackages = Array.isArray(legacyResult.packages) ? legacyResult.packages : [];
  const canonicalPackages = Array.isArray(canonicalResult.packages) ? canonicalResult.packages : [];
  const packages = canonicalPackages.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const {
      format_option_refs: _canonicalRefs,
      __selected_legacy_format_ids: _canonicalSelected,
      ...wirePackage
    } = value as Record<string, unknown>;
    const legacyPackage = legacyPackages[index];
    const legacyRecord = legacyPackage && typeof legacyPackage === 'object' && !Array.isArray(legacyPackage)
      ? legacyPackage as Record<string, unknown>
      : undefined;
    const selected = Array.isArray(legacyRecord?.__selected_legacy_format_ids)
      ? legacyRecord.__selected_legacy_format_ids
      : Array.isArray(legacyRecord?.format_ids)
        ? legacyRecord.format_ids
        : undefined;
    return {
      ...wirePackage,
      ...(selected !== undefined && { format_ids: selected }),
    };
  });
  return {
    ...canonicalResult,
    status: 'completed',
    ...(canonicalPackages.length > 0 && { packages }),
  };
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
      const id = 'public_sandbox';
      return {
        id,
        name: 'Public Sandbox',
        status: 'active',
        mode: 'sandbox',
        ctx_metadata: {
          task_owner_scope: taskOwnerScopeForRequest(ctx as TaskOwnerRequestContext, id),
          webhook_tenant_scope: webhookTenantScopeForPlatformContext({
            ...(ctx as TaskOwnerRequestContext),
            account: { id },
          }),
        },
        sandbox: true,
        authInfo: { kind: 'public', ...(principal && { principal }) },
      };
    }
    if (typeof ref !== 'object' || Array.isArray(ref)) {
      throw new AdcpError('INVALID_REQUEST', {
        message: 'account must be an object',
        field: 'account',
        recovery: 'correctable',
      });
    }
    const canonical = canonicalizeAccountRef(ref);
    const accountRef: ToolArgs['account'] = canonical.kind === 'account_id'
      ? { account_id: canonical.account_id }
      : {
          brand: canonical.brand,
          operator: canonical.operator,
          ...(canonical.operator_unit && { operator_unit: canonical.operator_unit }),
          ...(canonical.currency && { currency: canonical.currency }),
          ...(canonical.timezone && { timezone: canonical.timezone }),
          ...(canonical.sandbox && { sandbox: true }),
        };
    const brandDomain = canonical.kind === 'natural' ? canonical.brand.domain : undefined;
    const operator = canonical.kind === 'natural' ? canonical.operator : undefined;
    const id = canonical.kind === 'account_id'
      ? canonical.account_id
      : syntheticAccountIdFromRef(accountRef);
    return {
      id,
      name: brandDomain ?? id,
      status: 'active',
      mode: 'sandbox',
      ...(brandDomain != null && { brand: { domain: brandDomain } }),
      ...(operator && { operator }),
      ctx_metadata: {
        account_ref: accountRef,
        brand_domain: brandDomain,
        ...(operator && { operator }),
        task_owner_scope: taskOwnerScopeForRequest(ctx as TaskOwnerRequestContext, id),
        webhook_tenant_scope: webhookTenantScopeForPlatformContext({
          ...(ctx as TaskOwnerRequestContext),
          account: { id },
        }),
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
  taskRegistry?: TaskRegistry,
): NonNullable<LegacyMediaBuyHandlers['getProducts']> {
  return async (req, ctx) => {
    const normalizedReq = withResolvedAccountScope(
      req as unknown as Record<string, unknown>,
      ctx.account,
      storyboardCompat,
    );
    const normalizedRecord = normalizedReq as unknown as Record<string, unknown>;
    const buyingMode = normalizedRecord.buying_mode ?? 'brief';
    const pushConfig = buyingMode === 'wholesale'
      ? undefined
      : await validateAsyncGetProductsPushConfig(normalizedRecord.push_notification_config);
    const versionResolution = resolveServedAdcpVersion(normalizedReq as unknown as Record<string, unknown>);
    const trainingCtx = buildTrainingCtx(ctx, storyboardCompat);
    const servedAdcpVersion = ctx.servedAdcpVersion
      ?? (versionResolution.ok ? versionResolution.servedVersion : undefined);
    if (servedAdcpVersion) trainingCtx.servedAdcpVersion = servedAdcpVersion;
    const executed = await executeTrainingAgentTool('get_products', normalizedReq, trainingCtx);
    if (!executed.success) throwGetProductsExecutionError(executed.error ?? 'get_products failed');
    const rawResponse = executed.data as Record<string, unknown> | undefined;
    if (
      rawResponse?.status === 'submitted'
      && typeof rawResponse.task_id === 'string'
    ) {
      // A replay has already registered its original task. The request-level
      // idempotency cache adds replayed=true to the cached envelope, so do not
      // allocate a duplicate registry row or completion worker here.
      if (rawResponse.replayed !== true) {
        if (!taskRegistry) {
          throw new Error('Async get_products requires a configured task registry');
        }
        const account = ctx.account as { id?: unknown } | undefined;
        if (typeof account?.id !== 'string' || account.id.length === 0) {
          throw new Error('Async get_products requires a resolved account');
        }
        const taskId = rawResponse.task_id;
        const ownerScope = taskOwnerScopeForPlatformContext(ctx, account.id);
        const taskRef = await taskRegistry.create({
          tool: 'get_products',
          accountId: account.id,
          ownerScope,
          hasWebhook: pushConfig !== undefined,
          overrideTaskId: taskId,
        });
        const completionScope = {
          accountId: taskRef.accountId,
          ownerScope: taskRef.ownerScope,
          registryNamespace: taskRegistryNamespaceForTenant('sales'),
        };
        const completion = settleAsyncGetProductsTask({
          accountId: account.id,
          taskId,
          taskRef,
          taskRegistry,
          completionScope,
          pushConfig,
          ...(ctx.emitWebhook && { emitWebhook: ctx.emitWebhook }),
        });
        taskRegistry._registerBackground(taskId, taskRef, completion);
      }
      return rawResponse as Awaited<ReturnType<NonNullable<LegacyMediaBuyHandlers['getProducts']>>>;
    }
    const response = translateV5Result<{ products?: import('@adcp/sdk').LegacyProduct[] }>(
      executed.data,
      { allowAdvisories: true },
    );
    return projectGetProductsCompatibilityWire(
      response,
      req as unknown as Record<string, unknown>,
      servedAdcpVersion,
    ) as Awaited<ReturnType<NonNullable<LegacyMediaBuyHandlers['getProducts']>>>;
  };
}

/**
 * `get_reporting_status` is a first-class SDK MediaBuyHandlers operation.
 * It sits on the explicit handler seam until the compact SalesPlatform gains
 * the same method, rather than becoming a hand-registered custom MCP tool.
 */
export function legacyGetReportingStatusHandler(): NonNullable<LegacyMediaBuyHandlers['getReportingStatus']> {
  return async (req, ctx) => {
    const version = resolveServedAdcpVersion(req as unknown as Record<string, unknown>);
    if (!version.ok || !atLeastAdcpVersion(version.servedVersion, REPORTING_STATUS_ADCP_VERSION)) {
      throw new AdcpError('VERSION_UNSUPPORTED', {
        recovery: 'correctable',
        message: version.ok
          ? 'get_reporting_status is available only in AdCP 3.2 and later.'
          : version.message,
        field: 'adcp_version',
      });
    }
    const resolved = ctx.account as {
      id?: unknown;
      ctx_metadata?: { account_ref?: ToolArgs['account'] };
    } | undefined;
    const requestedAccount = resolved?.ctx_metadata?.account_ref
      ?? (req as unknown as ToolArgs).account;
    if (!requestedAccount) {
      throw new AdcpError('ACCOUNT_NOT_FOUND', {
        recovery: 'correctable',
        message: 'Reporting status requires a resolved account.',
        field: 'account',
      });
    }
    const principal = ctx.authInfo?.clientId;
    const reportingAccount = await resolveReportingAccountDurably(principal, requestedAccount);
    if (!reportingAccount) {
      return validateReliableReportingResponse(reportingStatusUnavailable(req.view));
    }
    const accountId = reportingAccount.accountId;
    const sessionArgs = {
      ...(req as unknown as ToolArgs),
      account: reportingAccount.account,
    };
    const session = await getSession(sessionKeyFromArgs(sessionArgs, 'open', undefined, undefined, principal));
    const reportingProducts = new Map(buildCatalog().map(entry => [entry.product.product_id, entry.product]));
    for (const [productId, product] of session.configuredProducts) reportingProducts.set(productId, product);
    const response = await getReportingStatusForAccountDurably(
      req as unknown as Parameters<typeof getReportingStatusForAccountDurably>[0],
      principal,
      accountId,
      [...session.mediaBuys.values()].map(mediaBuy => ({
        mediaBuyId: mediaBuy.mediaBuyId,
        startTime: mediaBuy.startTime,
        endTime: mediaBuy.canceledAt && mediaBuy.canceledAt < mediaBuy.endTime
          ? mediaBuy.canceledAt
          : mediaBuy.endTime,
        knownAt: mediaBuy.confirmedAt || mediaBuy.createdAt,
        effectiveAt: mediaBuy.updatedAt,
        packages: mediaBuy.packages.filter(pkg => !pkg.canceled).map(pkg => {
          const reportingCapabilities = reportingProducts.get(pkg.productId)?.reporting_capabilities as {
            reporting_delivery_offering_ids?: string[];
          } | undefined;
          const acceptedOfferingIds = mediaBuy.reportingOfferingIdsByPackage?.[pkg.packageId]
            ?? reportingCapabilities?.reporting_delivery_offering_ids
            ?? [];
          return {
            packageId: pkg.packageId,
            offeringIds: [...acceptedOfferingIds],
          };
        }),
      })),
    );
    return validateReliableReportingResponse(response);
  };
}

export function legacySyncReportingReceiptsHandler(): NonNullable<LegacyMediaBuyHandlers['syncReportingReceipts']> {
  return async (req, ctx) => {
    const version = resolveServedAdcpVersion(req as unknown as Record<string, unknown>);
    if (!version.ok || !atLeastAdcpVersion(version.servedVersion, REPORTING_STATUS_ADCP_VERSION)) {
      throw new AdcpError('VERSION_UNSUPPORTED', {
        recovery: 'correctable',
        message: 'sync_reporting_receipts is available only in AdCP 3.2 and later.',
        field: 'adcp_version',
      });
    }
    const resolved = ctx.account as { id?: unknown; ctx_metadata?: { account_ref?: ToolArgs['account'] } } | undefined;
    const requestedAccount = resolved?.ctx_metadata?.account_ref ?? (req as unknown as ToolArgs).account;
    if (!requestedAccount) {
      throw new AdcpError('ACCOUNT_NOT_FOUND', { recovery: 'correctable', message: 'Reporting receipts require a resolved account.', field: 'account' });
    }
    const principal = ctx.authInfo?.clientId;
    const reportingAccount = await resolveReportingAccountDurably(principal, requestedAccount);
    if (!reportingAccount) {
      throw new AdcpError('ACCOUNT_NOT_FOUND', { recovery: 'correctable', message: 'Reporting account was not found.', field: 'account' });
    }
    const response = await withDurableReportingLedger(
      principal,
      reportingAccount.accountId,
      true,
      () => syncReliableReportingReceiptsForAccount(
        req as unknown as Parameters<typeof syncReliableReportingReceiptsForAccount>[0],
        principal,
        reportingAccount.accountId,
      ),
      reportingAccount.account,
      reportingAccount.accountState,
    );
    return response as never;
  };
}

export async function reportingStatusForCustomTool(
  args: ToolArgs,
  ctx: TrainingContext,
): Promise<object> {
  const syntheticCtx = {
    authInfo: { clientId: ctx.principal },
    account: undefined as never,
  };
  try {
    return await legacyGetReportingStatusHandler()(args as never, syntheticCtx as never) as object;
  } catch (err) {
    if (err instanceof AdcpError) return adcpLegacyErrorPayload(err);
    throw err;
  }
}

export async function syncReportingReceiptsForCustomTool(
  args: ToolArgs,
  ctx: TrainingContext,
): Promise<object> {
  const syntheticCtx = {
    authInfo: { clientId: ctx.principal },
    account: undefined as never,
  };
  try {
    return await legacySyncReportingReceiptsHandler()(args as never, syntheticCtx as never) as object;
  } catch (err) {
    if (err instanceof AdcpError) return adcpLegacyErrorPayload(err);
    throw err;
  }
}

function adcpLegacyErrorPayload(err: AdcpError): { errors: Record<string, unknown>[] } {
  const ext = err as unknown as {
    code?: string;
    recovery?: string;
    field?: string;
    details?: unknown;
  };
  return {
    errors: [{
      code: ext.code ?? 'INTERNAL_ERROR',
      message: err.message,
      ...(ext.recovery && { recovery: ext.recovery }),
      ...(ext.field && { field: ext.field }),
      ...(ext.details !== undefined && { details: ext.details }),
    }],
  };
}

export function legacySyncCreativesHandler(
  storyboardCompat?: TrainingContext['storyboardCompat'],
): NonNullable<LegacyMediaBuyHandlers['syncCreatives']> {
  return async (req, ctx) => {
    const args = storyboardCompat?.version === '3.0'
      ? withResolvedAccountScope(
        req as unknown as Record<string, unknown>,
        ctx.account,
        storyboardCompat,
      )
      : withCurrentAccountScope(
        req as unknown as Record<string, unknown>,
        ctx.account,
        req,
      );
    return await handleSyncCreatives(
      args,
      buildTrainingCtx(ctx, storyboardCompat),
    ) as unknown as Awaited<ReturnType<NonNullable<LegacyMediaBuyHandlers['syncCreatives']>>>;
  };
}

export function legacyListCreativesHandler(
  storyboardCompat?: TrainingContext['storyboardCompat'],
): NonNullable<LegacyMediaBuyHandlers['listCreatives']> {
  return async (req, ctx) => {
    const args = storyboardCompat?.version === '3.0'
      ? withResolvedAccountScope(
        req as unknown as Record<string, unknown>,
        ctx.account,
        storyboardCompat,
      )
      : withCurrentAccountScope(
        req as unknown as Record<string, unknown>,
        ctx.account,
        req,
      );
    const response = await handleListCreatives(
      args,
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
  private readonly sellerManagedControlJobs?: SellerManagedControlJobCoordinator;

  constructor(
    private readonly storyboardCompat?: TrainingContext['storyboardCompat'],
    private readonly proposalNegotiationProfile: NonNullable<TrainingContext['proposalNegotiationProfile']> = 'ask-only',
    taskRegistry?: TaskRegistry,
  ) {
    if (taskRegistry) {
      this.sellerManagedControlJobs = new SellerManagedControlJobCoordinator(
        taskRegistry,
        async job => await runWithSessionContext(async () => {
          const executionArgs = structuredClone(job.request);
          if (job.executionContext.sharedPublicBrandDomain) {
            registerSharedPublicBrandPartition(
              executionArgs,
              job.executionContext.sharedPublicBrandDomain,
            );
          }
          return await handleControlMediaBuy(
            executionArgs as unknown as Parameters<typeof handleControlMediaBuy>[0],
            job.executionContext as unknown as TrainingContext,
            {
              sellerManagedExecution: {
                kind: 'execute',
                taskId: job.taskId,
                mediaBuyId: job.mediaBuyId,
                expectedRevision: job.expectedRevision,
                actions: job.authorizedActions,
              },
            },
          );
        }),
        undefined,
        async job => await emitDurableSellerManagedTaskWebhook({
          pushConfig: job.pushConfig,
          taskId: job.taskId,
          accountId: job.accountId,
          webhookTenantScope: job.webhookTenantScope,
          terminalAt: job.terminalAt ?? job.updatedAt,
          ...(job.result && { result: job.result }),
          ...(job.error && { error: job.error }),
        }),
      );
      this.sellerManagedControlJobs.start();
    }
  }

  get capabilities() {
    if (this.storyboardCompat?.version === '3.0') {
      const { reporting_delivery: _reportingDelivery, ...mediaBuy } = TRAINING_SALES_CAPABILITIES.overrides.media_buy;
      const { experimental_features: _experimentalFeatures, ...overrides } = TRAINING_SALES_CAPABILITIES.overrides;
      return {
        ...TRAINING_SALES_CAPABILITIES,
        specialisms: ['sales-non-guaranteed', 'sales-guaranteed'] as const,
        overrides: { ...overrides, media_buy: mediaBuy },
      };
    }
    return TRAINING_SALES_CAPABILITIES;
  }

  async acknowledgeSellerManagedWebhook(taskId: string): Promise<void> {
    await this.sellerManagedControlJobs?.acknowledgeFrameworkWebhook(taskId);
  }

  statusMappers = {};
  accounts: AccountStore<TrainingSalesMeta> = trainingSalesAccounts;
  agentRegistry = trainingBuyerAgentRegistry;

  sales: SalesPlatform<TrainingSalesMeta> = {
    createMediaBuy: async (req, ctx) => {
      const requestWithRawSelectors = restoreRawPackageSelectors(
        req as unknown as Record<string, unknown>,
        ctx.input,
        ['packages'],
      );
      const args = this.storyboardCompat?.version === '3.0'
        ? withResolvedAccountScope(
          requestWithRawSelectors,
          ctx.account,
          this.storyboardCompat,
        )
        : withCurrentAccountScope(requestWithRawSelectors, ctx.account, ctx.input);
      const v5Result = await handleCreateMediaBuy(args, buildTrainingCtx(ctx, this.storyboardCompat));
      // Detect the submitted-arm envelope the v5 handler returns when the
      // `force_create_media_buy_arm` test-controller directive is set.
      // The framework's projector rejects hand-rolled
      // `{ status: 'submitted', task_id }` shapes — the only path into
      // the submitted arm is `ctx.handoffToTask`. Pass the directive's
      // task_id through `TaskHandoffOptions.task_id` so the response
      // echoes the caller-supplied id (adcp-client#1554, SDK 6.11+).
      // Keep the handoff pending until force_task_completion resolves the
      // controller-side waiter. The framework then writes the same result to
      // its task registry, which makes get_task_status and list_tasks converge
      // on the controller-driven terminal state.
      if (
        v5Result &&
        typeof v5Result === 'object' &&
        (v5Result as { status?: unknown }).status === 'submitted' &&
        typeof (v5Result as { task_id?: unknown }).task_id === 'string'
      ) {
        const submitted = v5Result as { task_id: string; message?: string };
        const completionScope = taskRegistryScopeFromContext(ctx, 'sales');
        return ctx.handoffToTask(
          async () => await waitForForcedTaskCompletion(submitted.task_id, completionScope),
          { task_id: submitted.task_id },
        );
      }
      const platformResult = translateV5Result<CreateMediaBuyHandlerResult>(
        canonicalMediaBuyPlatformResult(v5Result),
      );
      // SDK 14 intentionally keeps synchronous terminal responses silent in
      // AdCP 3.2. Released 3.0 storyboards, however, require the historical
      // inline completion callback. Emit only on that compatibility surface,
      // through the same signed durable outbox used by all other training-agent
      // webhooks. Submitted task handoffs return above and remain framework-owned.
      if (this.storyboardCompat?.version === '3.0') {
        const webhookArgs = args as unknown as Record<string, unknown>;
        const webhookResult = projectCreateMediaBuyCompatibilityWebhookResult(
          v5Result as Record<string, unknown>,
          platformResult as unknown as Record<string, unknown>,
        );
        maybeEmitCompletionWebhook({
          toolName: 'create_media_buy',
          args: webhookArgs,
          response: webhookResult,
          requestIdempotencyKey: typeof webhookArgs.idempotency_key === 'string'
            ? webhookArgs.idempotency_key
            : undefined,
          principal: trustedWebhookPrincipal(ctx),
        });
      }
      return platformResult;
    },

    updateMediaBuy: async (buyId, patch, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const currentArgs = brandDomain
        ? { media_buy_id: buyId, ...(patch as unknown as Record<string, unknown>), brand: { domain: brandDomain } }
        : { media_buy_id: buyId, ...(patch as unknown as Record<string, unknown>) };
      const requestWithRawSelectors = restoreRawPackageSelectors(
        currentArgs,
        ctx.input,
        ['new_packages'],
      );
      const args = this.storyboardCompat?.version === '3.0'
        ? withResolvedAccountScope(requestWithRawSelectors, ctx.account, this.storyboardCompat)
        : withCurrentAccountScope(requestWithRawSelectors, ctx.account, ctx.input);
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
  };

  /** SDK 14's primary AdCP 3.2 surface. Legacy `sales` remains registered so
   * 3.0/3.1 callers can invoke the deprecated tool names explicitly. */
  get mediaBuyLifecycle(): MediaBuyLifecyclePlatform<TrainingSalesMeta> | undefined {
    if (this.storyboardCompat?.version === '3.0') return undefined;
    return {
    proposalRefinement: proposalCapabilitiesForProfile(this.proposalNegotiationProfile),

    listProducts: async (req, ctx) => translateV5Result(
      await executeProductDiscoveryPlatformTool(
        'list_products',
        withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input) as unknown as Record<string, unknown>,
        buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile),
      ),
      { allowAdvisories: true },
    ),

    requestProposals: async (req, ctx) => translateV5Result(
      await executeProductDiscoveryPlatformTool(
        'request_proposals',
        withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input) as unknown as Record<string, unknown>,
        buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile),
      ),
      { allowAdvisories: true },
    ),

    refineProposals: async (req, ctx) => {
      const trainingCtx = buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile);
      return translateV5Result(
        await executeProductDiscoveryPlatformTool(
          'refine_proposals',
          withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input) as unknown as Record<string, unknown>,
          trainingCtx,
        ),
        { allowAdvisories: true },
      );
    },

    declineProposals: async (req, ctx) => translateV5Result(
      await executeProductDiscoveryPlatformTool(
        'decline_proposals',
        withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input) as unknown as Record<string, unknown>,
        buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile),
      ),
      { allowAdvisories: true },
    ),

    buyProducts: async (req, ctx) => translateV5CommitmentResult(
      await handleBuyProducts(
        withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input) as Parameters<typeof handleBuyProducts>[0],
        buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile),
      ),
    ),

    acceptProposal: async (req, ctx) => translateV5Result(
      await handleAcceptProposal(
        withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input) as Parameters<typeof handleAcceptProposal>[0],
        buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile),
      ),
    ),

    controlMediaBuy: async (req, ctx) => {
      const args = withCurrentAccountScope(
        req as unknown as Record<string, unknown>,
        ctx.account,
        ctx.input,
      ) as Parameters<typeof handleControlMediaBuy>[0];
      const trainingCtx = buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile);
      const jobs = this.sellerManagedControlJobs;
      const accountId = (ctx.account as { id?: unknown } | undefined)?.id;
      if (typeof accountId !== 'string' || accountId.length === 0) {
        throw new AdcpError('ACCOUNT_NOT_FOUND', {
          recovery: 'correctable',
          message: 'Seller-managed control requires a resolved account.',
          field: 'account',
        });
      }
      const { push_notification_config: rawPushConfig, ...durableArgs } = args as unknown as Record<string, unknown>;
      const pushConfig = rawPushConfig && typeof rawPushConfig === 'object' && !Array.isArray(rawPushConfig)
        ? structuredClone(rawPushConfig as Record<string, unknown>)
        : undefined;
      const idempotencyKey = durableArgs.idempotency_key;
      const mediaBuyId = durableArgs.media_buy_id;
      const expectedRevision = durableArgs.revision;
      const idempotencyPrincipal = idempotencyPrincipalForPlatformContext(
        ctx as unknown as TaskOwnerRequestContext & { account?: unknown },
        args.account,
      );
      const ownerScope = taskOwnerScopeForPlatformContext(
        ctx as unknown as TaskOwnerRequestContext & { account?: unknown },
        accountId,
      );
      const webhookTenantScope = webhookTenantScopeForPlatformContext(
        ctx as unknown as TaskOwnerRequestContext & { account?: unknown },
      );
      if (jobs && typeof idempotencyKey === 'string' && typeof mediaBuyId === 'string'
        && typeof expectedRevision === 'number') {
        const replayInput = {
          accountId,
          idempotencyPrincipal,
          idempotencyKey,
          mediaBuyId,
          expectedRevision,
          request: structuredClone(durableArgs),
          ...(pushConfig && { pushConfig }),
        };
        const replay = await jobs.store.findReplay(replayInput);
        if (replay) {
          await jobs.reconnect(
            replayInput,
            replay,
            ownerScope,
            replay.hasWebhook ? webhookTenantScope : undefined,
          );
          return ctx.handoffToTask(
            async () => translateV5Result(await jobs.runTask(replay.taskId)),
            { task_id: replay.taskId },
          );
        }
      }
      const result = await handleControlMediaBuy(args, trainingCtx, {
        sellerManagedExecution: { kind: 'defer' },
      });
      if (!isSellerManagedControlTaskRequired(result)) return translateV5Result(result);

      if (!jobs) {
        throw new AdcpError('SERVICE_UNAVAILABLE', {
          recovery: 'transient',
          message: 'Seller-managed control execution is temporarily unavailable.',
        });
      }
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'correctable',
          message: 'Seller-managed control requires idempotency_key.',
          field: 'idempotency_key',
        });
      }
      const durableAccount = args.account;
      const sharedPublicBrandDomain = trainingCtx.principal?.startsWith('static:')
        && durableAccount?.sandbox === true
        && typeof durableAccount.brand?.domain === 'string'
        ? durableAccount.brand.domain.toLowerCase()
        : undefined;
      const job = await jobs.enqueue({
        accountId,
        idempotencyPrincipal,
        idempotencyKey,
        ownerScope,
        hasWebhook: pushConfig !== undefined,
        ...(pushConfig && webhookTenantScope && { webhookTenantScope }),
        ...(pushConfig && { pushConfig }),
        mediaBuyId: result.mediaBuyId,
        expectedRevision: result.expectedRevision,
        authorizedActions: result.actions,
        request: structuredClone(durableArgs),
        executionContext: {
          ...structuredClone(trainingCtx),
          requestInput: structuredClone(durableArgs),
          ...(sharedPublicBrandDomain && { sharedPublicBrandDomain }),
        } as SellerManagedControlJobContext,
      });

      // Commit the outbox before asking the framework to create its task row.
      // A replacement worker can recreate either side of that boundary from
      // the durable account/owner/action authorization captured above.
      return ctx.handoffToTask(
        async () => translateV5Result(await jobs.runTask(job.taskId)),
        { task_id: job.taskId },
      );
    },

    getMediaBuys: async (req, ctx) => {
      const trainingCtx = buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile);
      const result = await handleGetMediaBuys(
        withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input),
        trainingCtx,
      );
      return translateV5Result(canonicalMediaBuyPlatformResult(result));
    },

    getMediaBuyDelivery: async (req, ctx) => translateV5Result(
      await handleGetMediaBuyDelivery(
        withCurrentAccountScope(req as unknown as Record<string, unknown>, ctx.account, ctx.input),
        buildTrainingCtx(ctx, this.storyboardCompat, this.proposalNegotiationProfile),
      ),
    ),
    };
  }

  // Audience-targeting capability is declared above; expose sync_audiences
  // so audience_buy_flow can register audiences before referencing them in
  // targeting_overlay. The training agent does not claim the audience-sync
  // specialism — this is the buy-side sibling, gated on audience_targeting
  // capability rather than on the audience-sync storyboard.
  audiences: AudiencePlatform<TrainingSalesMeta> = {
    syncAudiences: async (audienceList, ctx) => {
      const brandDomain = brandDomainFromCtx(ctx.account);
      const requestInput = ctx.input && typeof ctx.input === 'object' && !Array.isArray(ctx.input)
        ? ctx.input as Record<string, unknown>
        : undefined;
      const isDiscovery = requestInput !== undefined
        && !Object.prototype.hasOwnProperty.call(requestInput, 'audiences');
      // sync_audiences requires idempotency_key per schema. The framework
      // strips it from per-row params; synthesise one so the v5 handler's
      // shape validation passes. The v5 handler doesn't enforce uniqueness
      // here — the framework already handled idempotency upstream. Preserve
      // the wire distinction between omitted audiences (discovery) and an
      // authored list: AudiencePlatform projects omission to [], so the raw
      // request context is the only place that distinction survives.
      const args = withCurrentAccountScope({
        ...(!isDiscovery && { audiences: audienceList }),
        idempotency_key: `framework-projected-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...(brandDomain && { brand: { domain: brandDomain } }),
      }, ctx.account, ctx.input);
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
