/**
 * createAdcpServer-based training agent server (behind feature flag).
 *
 * Routes all spec-declared tools through `@adcp/client/server`'s
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
 * Opt-in via `TRAINING_AGENT_USE_FRAMEWORK=1`. Defaults to legacy until
 * storyboard parity is verified and a follow-up PR flips the default.
 */

import { createAdcpServer } from '@adcp/client/server';
import type { HandlerContext, AdcpServerToolName } from '@adcp/client/server';
import { z } from 'zod';
import type { TrainingContext, ToolArgs } from './types.js';
import { getIdempotencyStore } from './idempotency.js';
import { getWebhookSigningKey } from './webhooks.js';
import { getRequestSigningCapability } from './request-signing.js';
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
import { handleSyncAccounts, handleSyncGovernance } from './account-handlers.js';
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
    const body: Record<string, unknown> = { adcp_error: errorObj };
    if (callerContext !== undefined) body.context = callerContext;
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }
  const inner = (result ?? {}) as Record<string, unknown>;
  const response = callerContext !== undefined ? { ...inner, context: callerContext } : inner;
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
  const body: Record<string, unknown> = { adcp_error: errorObj };
  if (callerContext !== undefined) body.context = callerContext;
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
  const body: Record<string, unknown> = { adcp_error: errorObj };
  if (callerContext !== undefined) body.context = callerContext;
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
 */
function adapt(handler: LegacyHandler) {
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

    try {
      const result = await Promise.resolve(handler(handlerArgs as ToolArgs, trainingCtx));
      return toAdaptedResponse(result, callerContext);
    } catch (err) {
      logger.error({ err }, 'framework handler threw');
      return serviceUnavailable(err, callerContext);
    }
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

// ── Server factory ──────────────────────────────────────────────

/**
 * Build the framework-based training-agent MCP server.
 *
 * Return type is `unknown` at the TS level and cast at the boundary —
 * `createAdcpServer` returns an `McpServer` typed through the SDK's
 * CJS build, while downstream consumers resolve the same symbol through
 * ESM. The two types are structurally identical but TypeScript treats
 * them as distinct (private `_serverInfo` field). Remove this escape
 * hatch when the SDK fixes its dual-package hazard (upstream issue).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createFrameworkTrainingAgentServer(_ctx: TrainingContext): any {
  const signingCap = getRequestSigningCapability();

  const server = createAdcpServer({
    name: 'adcp-training-agent',
    version: '1.0.0',

    idempotency: getIdempotencyStore(),
    webhooks: { signerKey: getWebhookSigningKey() },

    resolveIdempotencyPrincipal: (ctx: HandlerContext, params: Record<string, unknown>, _toolName: AdcpServerToolName) => {
      const auth = ctx.authInfo?.clientId ?? 'anonymous';
      if (auth !== 'static:public') return auth;
      const scope = deriveAccountScope(params);
      return `${auth}\u001F${scope ?? ''}`;
    },

    capabilities: {
      major_versions: [3],
      specialisms: ['signed-requests'],
      request_signing: {
        supported: signingCap.supported,
        covers_content_digest: signingCap.covers_content_digest,
        required_for: [...signingCap.required_for],
        ...(signingCap.supported_for && { supported_for: [...signingCap.supported_for] }),
      },
    },

    mediaBuy: {
      getProducts: adapt(handleGetProducts),
      createMediaBuy: adapt(handleCreateMediaBuy),
      updateMediaBuy: adapt(handleUpdateMediaBuy),
      getMediaBuys: adapt(handleGetMediaBuys),
      getMediaBuyDelivery: adapt(handleGetMediaBuyDelivery),
      providePerformanceFeedback: adapt(handleProvidePerformanceFeedback),
      listCreativeFormats: adapt(handleListCreativeFormats),
      syncCreatives: adapt(handleSyncCreatives),
      listCreatives: adapt(handleListCreatives),
    },
    creative: {
      buildCreative: adapt(handleBuildCreative),
      previewCreative: adapt(handlePreviewCreative),
      getCreativeDelivery: adapt(handleGetCreativeDelivery),
    },
    signals: {
      getSignals: adapt(handleGetSignals),
      activateSignal: adapt(handleActivateSignal),
    },
    governance: {
      syncPlans: adapt(handleSyncPlans),
      checkGovernance: adapt(handleCheckGovernance),
      reportPlanOutcome: adapt(handleReportPlanOutcome),
      getPlanAuditLogs: adapt(handleGetPlanAuditLogs),
      createPropertyList: adapt(handleCreatePropertyList),
      listPropertyLists: adapt(handleListPropertyLists),
      getPropertyList: adapt(handleGetPropertyList),
      updatePropertyList: adapt(handleUpdatePropertyList),
      deletePropertyList: adapt(handleDeletePropertyList),
      createContentStandards: adapt(handleCreateContentStandards),
      listContentStandards: adapt(handleListContentStandards),
      getContentStandards: adapt(handleGetContentStandards),
      updateContentStandards: adapt(handleUpdateContentStandards),
      calibrateContent: adapt(handleCalibrateContent),
      validateContentDelivery: adapt(handleValidateContentDelivery),
    },
    accounts: {
      syncAccounts: adapt(handleSyncAccounts),
      syncGovernance: adapt(handleSyncGovernance),
      reportUsage: adapt(handleReportUsage),
    },
    eventTracking: {
      syncEventSources: adapt(handleSyncEventSources),
      logEvent: adapt(handleLogEvent),
      syncCatalogs: adapt(handleSyncCatalogs),
    },
    brandRights: {
      getBrandIdentity: adapt(handleGetBrandIdentity),
      getRights: adapt(handleGetRights),
      acquireRights: adapt(handleAcquireRights),
    },
  });

  // NOTE: `get_adcp_capabilities` is auto-registered by the framework and
  // `registerTool` rejects duplicate names. We drive what we can via the
  // `capabilities:` config above; training-agent-specific fields
  // (publisher_domains, compliance_testing.scenarios, etc.) are absent on
  // the framework path. If storyboards depend on them, we'll need an SDK
  // escape hatch (either `capabilities.extensions_supported` on the
  // declaration or a `replaceTool` API on `McpServer`). Tracked in
  // FRAMEWORK_MIGRATION.md.

  // ── Custom tools outside AdcpToolMap ─────────────────────────
  // Each is a minimal passthrough-input tool — validation happens inside
  // the handler (as it does in the legacy dispatch path).
  const passthroughInput = { _passthrough: z.any().optional() };

  function registerCustom(name: string, description: string, handler: LegacyHandler) {
    server.registerTool(
      name,
      { description, inputSchema: passthroughInput },
      async (args, extra) => {
        // MCP SDK parses the caller's raw args against our passthrough
        // schema — the schema allows any shape, so `args` is effectively
        // the caller-supplied object. Extract our conventional fields.
        const params = (args as Record<string, unknown>) ?? {};
        const authInfo = (extra?.authInfo ?? undefined) as { clientId?: string } | undefined;
        const trainingCtx: TrainingContext = {
          mode: 'open',
          principal: authInfo?.clientId ?? 'anonymous',
        };
        const { context: callerContext, _passthrough: _pt, ...handlerArgs } = params;
        try {
          const result = await Promise.resolve(handler(handlerArgs as ToolArgs, trainingCtx));
          return toAdaptedResponse(result, callerContext);
        } catch (err) {
          logger.error({ err, tool: name }, 'framework custom-tool handler threw');
          return serviceUnavailable(err, callerContext);
        }
      },
    );
  }

  registerCustom('creative_approval', 'Approve or reject a creative asset for a media buy.', handleCreativeApproval);
  registerCustom('update_rights', 'Update the terms of an active rights grant.', handleUpdateRights);
  registerCustom('validate_property_delivery', 'Validate that delivered properties comply with a property list.', handleValidatePropertyDelivery);
  registerCustom('create_collection_list', 'Create a collection list of property list references.', handleCreateCollectionList);
  registerCustom('get_collection_list', 'Fetch a collection list by id.', handleGetCollectionList);
  registerCustom('update_collection_list', 'Update a collection list\'s member references.', handleUpdateCollectionList);
  registerCustom('list_collection_lists', 'List all collection lists in the session.', handleListCollectionLists);
  registerCustom('delete_collection_list', 'Delete a collection list by id.', handleDeleteCollectionList);
  registerCustom('comply_test_controller', 'Training-agent compliance helper for forcing statuses and simulating delivery/spend.', handleComplyTestController);

  logger.info({ signingCap: signingCap.supported }, 'Framework training agent server constructed');

  return server;
}

/**
 * Returns true when the framework path should be used. Default is legacy.
 * Flip via `TRAINING_AGENT_USE_FRAMEWORK=1`.
 */
export function useFrameworkServer(): boolean {
  const v = process.env.TRAINING_AGENT_USE_FRAMEWORK;
  return v === '1' || v === 'true';
}
