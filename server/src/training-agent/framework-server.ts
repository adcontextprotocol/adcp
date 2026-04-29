/**
 * createAdcpServer-based training agent server (behind feature flag).
 *
 * Routes all spec-declared tools through `@adcp/sdk/server`'s
 * `createAdcpServer` domain-grouped config so idempotency, capability
 * declaration, signed-requests verification, and webhook emission are
 * handled by the framework rather than our hand-rolled dispatch.
 *
 * Handlers emit pre-formatted `CallToolResult` envelopes so the
 * framework's `isFormattedResponse` check passes through — response
 * bytes remain byte-identical to the legacy dispatch path, which keeps
 * every existing unit test and storyboard valid without re-baselining.
 *
 * Custom tools outside `AdcpToolMap` (`creative_approval`,
 * `update_rights`, `comply_test_controller`, `validate_property_delivery`,
 * the five collection-list endpoints) register directly on the returned
 * server via `registerTool` after `createAdcpServer` returns.
 *
 * Default dispatch path since both modes hit 52/52 storyboard parity.
 * Legacy stays reachable via `TRAINING_AGENT_USE_FRAMEWORK=0` for one
 * release as an escape hatch; a follow-up PR deletes the legacy dispatch
 * after burn-in.
 */

import { createAdcpServer, wrapEnvelope } from '@adcp/sdk/server';
import { mergeSeedProduct } from '@adcp/sdk/testing';
import type { HandlerContext, AdcpServerToolName, AdcpServer, AdcpCustomToolConfig } from '@adcp/sdk/server';
import { MediaChannelSchema } from '@adcp/sdk/types';
import type { Product } from '@adcp/sdk';
import { z } from 'zod';
import type { TrainingContext, ToolArgs, AccountRef, BrandRef } from './types.js';
import { getIdempotencyStore, scopedPrincipal } from './idempotency.js';
import { getWebhookSigningMaterial, maybeEmitCompletionWebhook } from './webhooks.js';
import { selectSigningCapability } from './request-signing.js';
import { PUBLISHERS } from './publishers.js';
import { getSession, runWithSessionContext, flushDirtySessions, sessionKeyFromArgs } from './state.js';
import { createLogger } from '../logger.js';

import {
  handleGetProducts,
  handleCreateMediaBuy,
  handleUpdateMediaBuy,
  handleGetMediaBuys,
  handleGetMediaBuyDelivery,
  handleGetCreativeDelivery,
  handleSyncCreatives,
  handleListCreatives,
  handleBuildCreative,
  handlePreviewCreative,
  handleListCreativeFormats,
  handleGetSignals,
  handleActivateSignal,
  handleReportUsage,
} from './task-handlers.js';
import { handleSyncAccounts, handleSyncGovernance, handleListAccounts } from './account-handlers.js';
import {
  handleSyncCatalogs,
  handleSyncEventSources,
  handleLogEvent,
  handleProvidePerformanceFeedback,
} from './catalog-event-handlers.js';
import {
  handleSyncPlans,
  handleCheckGovernance,
  handleReportPlanOutcome,
  handleGetPlanAuditLogs,
} from './governance-handlers.js';
import {
  handleGetBrandIdentity,
  handleGetRights,
  handleAcquireRights,
  handleUpdateRights,
  handleCreativeApproval,
} from './brand-handlers.js';
import {
  handleCreatePropertyList,
  handleListPropertyLists,
  handleGetPropertyList,
  handleUpdatePropertyList,
  handleDeletePropertyList,
  handleValidatePropertyDelivery,
} from './property-handlers.js';
import {
  handleCreateCollectionList,
  handleGetCollectionList,
  handleUpdateCollectionList,
  handleListCollectionLists,
  handleDeleteCollectionList,
} from './inventory-governance-handlers.js';
import {
  handleCreateContentStandards,
  handleListContentStandards,
  handleGetContentStandards,
  handleUpdateContentStandards,
  handleCalibrateContent,
  handleValidateContentDelivery,
} from './content-standards-handlers.js';
import { handleComplyTestController } from './comply-test-controller.js';

const logger = createLogger('training-agent-framework');

const SUPPORTED_MAJOR_VERSIONS = [3] as const;

// Baseline seeded-product fields — fills in the Product response-schema
// minimums (description, publisher_properties, format_ids, pricing_options,
// reporting_capabilities, delivery_type) so storyboards that seed a sparse
// `{ name, channels }` fixture still emit a schema-valid product.
const SEED_PRODUCT_DEFAULTS: Partial<Product> = {
  description: 'Seeded sandbox fixture product',
  delivery_type: 'non_guaranteed',
  publisher_properties: [],
  format_ids: [],
  pricing_options: [],
  reporting_capabilities: {
    available_metrics: [],
    available_reporting_frequencies: ['daily'],
    expected_delay_minutes: 240,
    timezone: 'UTC',
    supports_webhooks: false,
    date_range_support: 'date_range',
  },
};

// ── Types ────────────────────────────────────────────────────────

type LegacyHandler = (args: ToolArgs, ctx: TrainingContext) => object | Promise<object>;

interface InlineError {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
  recovery?: string;
}

/**
 * Shape satisfies the framework's `McpToolResponse` (content + non-null
 * structuredContent) and the MCP SDK's `CallToolResult` (content +
 * optional structuredContent). Index signature keeps it assignable to
 * `Record<string, unknown>` so both `DomainHandler` and `ToolCallback`
 * return-type unions accept it.
 */
interface AdaptedResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

// ── Response shaping ─────────────────────────────────────────────

function toAdaptedResponse(result: unknown, callerContext: unknown): AdaptedResponse {
  const errsField = (result as { errors?: unknown[] } | null | undefined)?.errors;
  if (Array.isArray(errsField) && errsField.length > 0) {
    const first = errsField[0] as InlineError;
    const errorObj: Record<string, unknown> = { code: first.code, message: first.message };
    if (first.field) errorObj.field = first.field;
    if (first.details !== undefined) errorObj.details = first.details;
    if (first.recovery) errorObj.recovery = first.recovery;
    const body = wrapEnvelope({ adcp_error: errorObj }, { context: callerContext });
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }
  const inner = (result ?? {}) as Record<string, unknown>;
  // wrapEnvelope stamps the AdCP context-echo envelope. `replayed` is
  // intentionally NOT set here — per protocol-envelope.json and the
  // SDK's injectReplayed helper, fresh executions MUST omit the field
  // (the framework stamps `replayed: true` only on idempotency replays).
  const withEnvelope = wrapEnvelope(inner, {
    ...(callerContext !== undefined && typeof callerContext === 'object' && callerContext !== null
      ? { context: callerContext }
      : {}),
  });
  const response = withEnvelope as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    structuredContent: response,
  };
}

function serviceUnavailable(err: unknown, callerContext: unknown): AdaptedResponse {
  const errorObj: Record<string, unknown> = {
    code: 'SERVICE_UNAVAILABLE',
    message: err instanceof Error ? err.message : 'Unknown error',
    recovery: 'transient',
  };
  const body = wrapEnvelope({ adcp_error: errorObj }, { context: callerContext });
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function versionUnsupported(requested: unknown, callerContext: unknown): AdaptedResponse {
  const errorObj: Record<string, unknown> = {
    code: 'VERSION_UNSUPPORTED',
    message: `AdCP major version ${String(requested)} is not supported`,
    details: { supported_major_versions: SUPPORTED_MAJOR_VERSIONS },
    field: 'adcp_major_version',
  };
  const body = wrapEnvelope({ adcp_error: errorObj }, { context: callerContext });
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

// ── Handler adapter ──────────────────────────────────────────────

/**
 * Convert a legacy `(args, TrainingContext)` handler into the framework's
 * `(params, HandlerContext) => Promise<AdaptedResponse>` signature.
 *
 * - Enforces `VERSION_UNSUPPORTED` for `adcp_major_version !== 3` (legacy
 *   dispatch behavior, not yet in the framework).
 * - Strips `context` from params before calling the handler, then re-stamps
 *   it on the response (so handlers never see or forward `context` and the
 *   framework's own injectContextIntoResponse doesn't double-echo).
 * - Wraps thrown exceptions as `SERVICE_UNAVAILABLE` per legacy behavior.
 * - Fires a completion webhook after a successful handler when the buyer
 *   supplied `push_notification_config.url` and the tool maps to a webhook
 *   task type. Matches legacy dispatch behavior in `task-handlers.ts`.
 */
function adapt(toolName: string, handler: LegacyHandler) {
  return async (params: unknown, ctx: HandlerContext): Promise<AdaptedResponse> => {
    const rawParams = (params as Record<string, unknown> | undefined) ?? {};
    const { context: callerContext, ...handlerArgs } = rawParams;

    const requestedVersion = (handlerArgs as { adcp_major_version?: unknown }).adcp_major_version;
    if (
      requestedVersion !== undefined
      && !(SUPPORTED_MAJOR_VERSIONS as readonly number[]).includes(requestedVersion as number)
    ) {
      return versionUnsupported(requestedVersion, callerContext);
    }

    const trainingCtx: TrainingContext = {
      mode: 'open',
      principal: ctx.authInfo?.clientId ?? 'anonymous',
    };

    return runWithSessionContext(async () => {
      let result: unknown;
      try {
        result = await Promise.resolve(handler(handlerArgs as ToolArgs, trainingCtx));
      } catch (err) {
        logger.error({ err }, 'framework handler threw');
        return serviceUnavailable(err, callerContext);
      }
      try {
        await flushDirtySessions();
      } catch (err) {
        logger.error({ err }, 'framework flushDirtySessions threw');
        return serviceUnavailable(err, callerContext);
      }
      const response = toAdaptedResponse(result, callerContext);
      if (!response.isError) {
        const idk = (handlerArgs as { idempotency_key?: unknown }).idempotency_key;
        maybeEmitCompletionWebhook({
          toolName,
          args: handlerArgs as Record<string, unknown>,
          response: (result ?? {}) as Record<string, unknown>,
          requestIdempotencyKey: typeof idk === 'string' ? idk : undefined,
          principal: scopedWebhookPrincipal(ctx, handlerArgs as Record<string, unknown>),
        });
      }
      return response;
    });
  };
}

// ── Resolver hooks ───────────────────────────────────────────────

function deriveAccountScope(params: Record<string, unknown>): string | undefined {
  const account = params.account as { account_id?: string; brand?: { domain?: string } } | undefined;
  if (account?.account_id && typeof account.account_id === 'string') {
    return `a:${account.account_id}`;
  }
  const domain = account?.brand?.domain
    ?? (params.brand as { domain?: string } | undefined)?.domain;
  if (typeof domain === 'string' && domain.length > 0) {
    return `b:${domain.toLowerCase()}`;
  }
  return undefined;
}

/** Scoped principal for webhook idempotency. Mirrors the
 *  `resolveIdempotencyPrincipal` rule on the AdcpServer config below: only
 *  `static:public` (the shared sandbox token) needs account-level partitioning;
 *  other principals are single-caller and use the auth principal directly.
 *  Delegates to `scopedPrincipal` so the partition format stays defined in
 *  one place and can never drift from the request-side cache. */
function scopedWebhookPrincipal(ctx: HandlerContext, params: Record<string, unknown>): string {
  const auth = ctx.authInfo?.clientId ?? 'anonymous';
  if (auth !== 'static:public') return auth;
  return scopedPrincipal(auth, deriveAccountScope(params));
}

// ── Server factory ──────────────────────────────────────────────

/**
 * Build the framework-based training-agent MCP server. Returns the
 * opaque `AdcpServer` handle from `@adcp/sdk/server` — no SDK types
 * escape our module boundary.
 */
export function createFrameworkTrainingAgentServer(ctx: TrainingContext): AdcpServer {
  const signingCap = selectSigningCapability(ctx);

  // ── Custom tools outside AdcpToolMap ─────────────────────────
  // Registered through the framework's `customTools` config (5.4).
  // Each tool ships a real zod inputSchema so `tools/list` publishes the
  // actual argument contract — MCP clients (Claude Desktop, inspector,
  // schema-driven callers) see the real fields instead of a `_passthrough`
  // placeholder. Handlers still do semantic validation (NOT_FOUND,
  // VALIDATION_ERROR); zod only gates type shape at the MCP surface.
  //
  // Schemas are permissive (`.passthrough()` / `z.any()` nested) because
  // the training agent emulates a full seller/brand and accepts spec
  // payload variants that evolve faster than we want to tighten here.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function customToolFor(name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: LegacyHandler): AdcpCustomToolConfig<any, undefined> {
    return {
      description,
      inputSchema,
      handler: async (args: unknown, extra: unknown) => {
        const params = (args as Record<string, unknown>) ?? {};
        const authInfo = ((extra as { authInfo?: { clientId?: string } } | undefined)?.authInfo) ?? undefined;
        const trainingCtx: TrainingContext = {
          mode: 'open',
          principal: authInfo?.clientId ?? 'anonymous',
        };
        const { context: callerContext, ...handlerArgs } = params;
        return runWithSessionContext(async () => {
          let result: unknown;
          try {
            result = await Promise.resolve(handler(handlerArgs as ToolArgs, trainingCtx));
          } catch (err) {
            logger.error({ err, tool: name }, 'framework custom-tool handler threw');
            return serviceUnavailable(err, callerContext);
          }
          try {
            await flushDirtySessions();
          } catch (err) {
            logger.error({ err, tool: name }, 'framework custom-tool flushDirtySessions threw');
            return serviceUnavailable(err, callerContext);
          }
          return toAdaptedResponse(result, callerContext);
        });
      },
    };
  }

  const ACCOUNT_REF = z.object({
    publisher_id: z.string().optional(),
    buyer_id: z.string().optional(),
    sandbox: z.boolean().optional(),
  }).passthrough().optional();

  const BRAND_REF = z.object({
    domain: z.string().optional(),
  }).passthrough().optional();

  const CONTEXT_REF = z.any().optional();

  const CREATIVE_APPROVAL_SCHEMA = {
    rights_id: z.string().optional(),
    rights_grant_id: z.string().optional(),
    creative_url: z.string().optional(),
    creative_id: z.string().optional(),
    creative_format: z.string().optional(),
    creative: z.object({
      creative_id: z.string().optional(),
      format: z.string().optional(),
      assets: z.array(z.any()).optional(),
    }).passthrough().optional(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  const UPDATE_RIGHTS_SCHEMA = {
    rights_id: z.string(),
    end_date: z.string().optional(),
    impression_cap: z.number().optional(),
    paused: z.boolean().optional(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  const VALIDATE_PROPERTY_DELIVERY_SCHEMA = {
    list_id: z.string(),
    account: ACCOUNT_REF,
    records: z.array(z.object({
      identifier: z.object({ type: z.string(), value: z.string() }).passthrough(),
      impressions: z.number().int().min(0),
      record_id: z.string().optional(),
    }).passthrough()),
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  const CREATE_COLLECTION_LIST_SCHEMA = {
    name: z.string(),
    description: z.string().optional(),
    base_collections: z.array(z.any()).optional(),
    filters: z.record(z.string(), z.any()).optional(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  const GET_COLLECTION_LIST_SCHEMA = {
    list_id: z.string(),
    resolve: z.boolean().optional(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  const UPDATE_COLLECTION_LIST_SCHEMA = {
    list_id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    base_collections: z.array(z.any()).optional(),
    filters: z.record(z.string(), z.any()).optional(),
    webhook_url: z.string().optional(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  const LIST_COLLECTION_LISTS_SCHEMA = {
    name_contains: z.string().optional(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
    pagination: z.object({
      max_results: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }).optional(),
  };

  const DELETE_COLLECTION_LIST_SCHEMA = {
    list_id: z.string(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  // `scenario` stays an open string rather than z.enum so unrecognized
  // scenarios reach the SDK handler and get a typed `UNKNOWN_SCENARIO`
  // response envelope. A zod enum here would reject at MCP input validation,
  // returning a generic validation error without the controller's context
  // echo — breaking the deterministic_testing storyboard's unknown-scenario
  // probe. Seed scenarios (seed_product, seed_creative, etc.) are also
  // accepted here for the same reason.
  const COMPLY_TEST_CONTROLLER_SCHEMA = {
    scenario: z.string(),
    params: z.record(z.string(), z.any()).optional(),
    account: ACCOUNT_REF,
    brand: BRAND_REF,
    context: CONTEXT_REF,
  };

  const allChannels = [...new Set(PUBLISHERS.flatMap(p => p.channels))]
    .map(c => MediaChannelSchema.parse(c))
    .sort();

  const server = createAdcpServer({
    name: 'adcp-training-agent',
    version: '1.0.0',

    idempotency: getIdempotencyStore(),
    webhooks: getWebhookSigningMaterial(),

    // Only `static:public` is account-scoped: it's the shared sandbox token,
    // so unscoped idempotency keys would collide across callers. Other
    // principals (`workos:<orgId>`, `static:primary`, `signing:<keyid>`) are
    // single-caller and use the auth principal directly — callers that want
    // account isolation within one org include `account.{publisher,buyer}_id`
    // in the idempotency key payload, which the SDK's canonical hash already
    // differentiates. Revisit if a shared-token pattern emerges for orgs.
    resolveIdempotencyPrincipal: (ctx: HandlerContext, params: Record<string, unknown>, _toolName: AdcpServerToolName) => {
      const auth = ctx.authInfo?.clientId ?? 'anonymous';
      if (auth !== 'static:public') return auth;
      const scope = deriveAccountScope(params);
      return `${auth}\u001F${scope ?? ''}`;
    },

    // Seeded-product bridge: flow `comply_test_controller.seed_product`
    // fixtures into `get_products` responses on sandbox requests. Our seed
    // store is session-scoped (one Map per brand.domain/account_id), so
    // the SDK's `bridgeFromTestControllerStore(store, defaults)` helper
    // (which closes over a `Map<string, unknown>` at server-construction
    // time, before the request is parsed) doesn't fit. We session-load in
    // the callback and run each fixture through `mergeSeedProduct` on top
    // of `SEED_PRODUCT_DEFAULTS` (the response-schema minimum fields).
    // `bridgeFromSessionStore` in @adcp/sdk 5.14+ collapses this to a
    // one-liner — pending adcp-client#866 (5.14 storyboard regression).
    //
    // Security: the dispatcher's sandbox gate is `isSandboxRequest(params)`
    // + (when `resolveAccount` is wired) `ctx.account.sandbox === true`.
    // We don't wire `resolveAccount` — by design for the training agent —
    // so the *only* fence is `isSandboxRequest`. Sessions are keyed by
    // `brand.domain` / `account_id`, not by auth principal. Any caller
    // authenticated via the training-agent bearer authenticator that sends
    // `context.sandbox: true` (or `account.sandbox: true`) plus another
    // caller's `brand.domain` will read that tenant's seeded fixtures.
    // Acceptable for this surface: fixture data is non-sensitive by design
    // (see `buildBearerAuthenticator` in ./index.ts for the sandbox
    // security posture). Production sellers adopting this wiring SHOULD
    // configure `resolveAccount` so the dispatcher's belt-and-suspenders
    // second gate activates.
    testController: {
      async getSeededProducts(bridgeCtx) {
        const args = bridgeCtx.input as { account?: AccountRef; brand?: BrandRef };
        const session = await getSession(sessionKeyFromArgs(args, 'open'));
        const seeded = session.complyExtensions.seededProducts;
        if (seeded.size === 0) return [];
        return Array.from(seeded.entries()).map(([productId, fixture]) => {
          const base = { ...SEED_PRODUCT_DEFAULTS, product_id: productId } as Partial<Product>;
          return mergeSeedProduct(base, fixture as Partial<Product>) as Product;
        });
      },
    },

    capabilities: {
      major_versions: [3],
      specialisms: [],
      features: {
        inlineCreativeManagement: true,
        propertyListFiltering: true,
        contentStandards: true,
        conversionTracking: true,
        audienceTargeting: true,
      },
      account: {
        requireOperatorAuth: false,
        supportedBilling: ['agent', 'operator', 'advertiser'],
      },
      creative: {
        hasCreativeLibrary: true,
        supportsTransformation: true,
        supportsGeneration: true,
        supportsCompliance: false,
      },
      request_signing: {
        supported: signingCap.supported,
        covers_content_digest: signingCap.covers_content_digest,
        required_for: [...signingCap.required_for],
        ...(signingCap.supported_for && { supported_for: [...signingCap.supported_for] }),
      },
      // 5.5 `overrides`: deep-merged on top of the framework's auto-derived
      // response so training-agent-specific fields (publisher portfolio,
      // compliance_testing scenarios, per-domain targeting surface) surface
      // on `get_adcp_capabilities` without needing to replace the tool.
      overrides: {
        media_buy: {
          portfolio: {
            publisher_domains: PUBLISHERS.map(p => p.domain),
            primary_channels: allChannels,
          },
          content_standards: {
            supports_local_evaluation: true,
            supported_channels: allChannels,
            supports_webhook_delivery: false,
          },
          audience_targeting: {
            supported_identifier_types: ['hashed_email'],
            minimum_audience_size: 100,
          },
          conversion_tracking: {
            supported_event_types: ['purchase', 'add_to_cart', 'lead', 'page_view'],
            supported_hashed_identifiers: ['hashed_email'],
            supported_action_sources: ['website', 'app'],
          },
          execution: {
            targeting: {
              geo_countries: true,
              geo_regions: true,
              geo_metros: { nielsen_dma: true },
              geo_postal_areas: { us_zip: true },
              language: true,
              keyword_targets: { supported_match_types: ['broad', 'phrase', 'exact'] },
              negative_keywords: { supported_match_types: ['broad', 'phrase', 'exact'] },
            },
          },
        },
        compliance_testing: {
          scenarios: [
            'force_creative_status',
            'force_account_status',
            'force_media_buy_status',
            'force_session_status',
            'simulate_delivery',
            'simulate_budget_spend',
          ],
        },
      },
    },

    mediaBuy: {
      getProducts: adapt('get_products', handleGetProducts),
      createMediaBuy: adapt('create_media_buy', handleCreateMediaBuy),
      updateMediaBuy: adapt('update_media_buy', handleUpdateMediaBuy),
      getMediaBuys: adapt('get_media_buys', handleGetMediaBuys),
      getMediaBuyDelivery: adapt('get_media_buy_delivery', handleGetMediaBuyDelivery),
      providePerformanceFeedback: adapt('provide_performance_feedback', handleProvidePerformanceFeedback),
      listCreativeFormats: adapt('list_creative_formats', handleListCreativeFormats),
      syncCreatives: adapt('sync_creatives', handleSyncCreatives),
      listCreatives: adapt('list_creatives', handleListCreatives),
    },
    creative: {
      buildCreative: adapt('build_creative', handleBuildCreative),
      previewCreative: adapt('preview_creative', handlePreviewCreative),
      getCreativeDelivery: adapt('get_creative_delivery', handleGetCreativeDelivery),
    },
    signals: {
      getSignals: adapt('get_signals', handleGetSignals),
      activateSignal: adapt('activate_signal', handleActivateSignal),
    },
    governance: {
      syncPlans: adapt('sync_plans', handleSyncPlans),
      checkGovernance: adapt('check_governance', handleCheckGovernance),
      reportPlanOutcome: adapt('report_plan_outcome', handleReportPlanOutcome),
      getPlanAuditLogs: adapt('get_plan_audit_logs', handleGetPlanAuditLogs),
      createPropertyList: adapt('create_property_list', handleCreatePropertyList),
      listPropertyLists: adapt('list_property_lists', handleListPropertyLists),
      getPropertyList: adapt('get_property_list', handleGetPropertyList),
      updatePropertyList: adapt('update_property_list', handleUpdatePropertyList),
      deletePropertyList: adapt('delete_property_list', handleDeletePropertyList),
      createContentStandards: adapt('create_content_standards', handleCreateContentStandards),
      listContentStandards: adapt('list_content_standards', handleListContentStandards),
      getContentStandards: adapt('get_content_standards', handleGetContentStandards),
      updateContentStandards: adapt('update_content_standards', handleUpdateContentStandards),
      calibrateContent: adapt('calibrate_content', handleCalibrateContent),
      validateContentDelivery: adapt('validate_content_delivery', handleValidateContentDelivery),
    },
    accounts: {
      syncAccounts: adapt('sync_accounts', handleSyncAccounts),
      listAccounts: adapt('list_accounts', handleListAccounts),
      syncGovernance: adapt('sync_governance', handleSyncGovernance),
      reportUsage: adapt('report_usage', handleReportUsage),
    },
    eventTracking: {
      syncEventSources: adapt('sync_event_sources', handleSyncEventSources),
      logEvent: adapt('log_event', handleLogEvent),
      syncCatalogs: adapt('sync_catalogs', handleSyncCatalogs),
    },
    brandRights: {
      getBrandIdentity: adapt('get_brand_identity', handleGetBrandIdentity),
      getRights: adapt('get_rights', handleGetRights),
      acquireRights: adapt('acquire_rights', handleAcquireRights),
    },

    customTools: {
      creative_approval: customToolFor('creative_approval', 'Submit a generated creative for brand approval against rights grant terms.', CREATIVE_APPROVAL_SCHEMA, handleCreativeApproval),
      update_rights: customToolFor('update_rights', 'Update an existing rights grant — extend dates, adjust impression caps, or pause/resume.', UPDATE_RIGHTS_SCHEMA, handleUpdateRights),
      validate_property_delivery: customToolFor('validate_property_delivery', 'Validate that delivered properties comply with a property list.', VALIDATE_PROPERTY_DELIVERY_SCHEMA, handleValidatePropertyDelivery),
      create_collection_list: customToolFor('create_collection_list', 'Create a collection list for program-level brand safety.', CREATE_COLLECTION_LIST_SCHEMA, handleCreateCollectionList),
      get_collection_list: customToolFor('get_collection_list', 'Retrieve a collection list with optional resolution.', GET_COLLECTION_LIST_SCHEMA, handleGetCollectionList),
      update_collection_list: customToolFor('update_collection_list', 'Modify an existing collection list.', UPDATE_COLLECTION_LIST_SCHEMA, handleUpdateCollectionList),
      list_collection_lists: customToolFor('list_collection_lists', 'List collection lists owned by the given account.', LIST_COLLECTION_LISTS_SCHEMA, handleListCollectionLists),
      delete_collection_list: customToolFor('delete_collection_list', 'Delete a collection list.', DELETE_COLLECTION_LIST_SCHEMA, handleDeleteCollectionList),
      comply_test_controller: customToolFor('comply_test_controller', 'Training-agent compliance helper for forcing statuses and simulating delivery/spend. Sandbox only.', COMPLY_TEST_CONTROLLER_SCHEMA, handleComplyTestController),
    },
  });

  logger.debug({ signingCap: signingCap.supported }, 'Framework training agent server constructed');

  return server;
}

/**
 * Returns true when the framework path should be used. Default is ON now
 * that both dispatch modes hit 52/52 storyboard parity. Set
 * `TRAINING_AGENT_USE_FRAMEWORK=0` (or `=false`) to fall back to legacy
 * as an escape hatch; the fallback exists for one release so a regression
 * in the flipped-default config has a clean rollback before legacy is
 * deleted.
 */
export function useFrameworkServer(): boolean {
  const v = process.env.TRAINING_AGENT_USE_FRAMEWORK;
  // Default ON (framework dispatch). Framework storyboards have been at
  // 52/52 clean since the envelope + session-fallback work landed;
  // legacy stays alive as an explicit opt-out escape hatch
  // (`TRAINING_AGENT_USE_FRAMEWORK=0`) for one release so a regression
  // shows up on the flipped-default config before legacy deletion.
  if (v === '0' || v === 'false') return false;
  return true;
}
