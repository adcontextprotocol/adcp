/**
 * Custom-tool helper for tenants that need to register tools outside the
 * platform interface (e.g., `/brand` registering `update_rights` /
 * `creative_approval` while waiting for them to land in `AdcpToolMap`).
 *
 * Wraps a v5-style `(ToolArgs, TrainingContext) → object` handler into
 * the SDK's `AdcpCustomToolConfig` shape so it can ride the
 * `opts.customTools` merge seam on `createAdcpServerFromPlatform`.
 */

import { z } from 'zod';
import { wrapEnvelope } from '@adcp/sdk/server';
import { TOOL_REQUEST_SCHEMAS } from '@adcp/sdk/schemas';
import type { LegacyAdcpCustomToolConfig as AdcpCustomToolConfig } from '@adcp/sdk/server';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../logger.js';
import { runWithSessionContext, flushDirtySessions } from '../state.js';
import type { ToolArgs, TrainingContext } from '../types.js';
import { projectTaskOutcomeForRelease } from '../served-outcome-status.js';
import { governanceAgentCredentialFromExtra, hostedGraderCredentialFromExtra } from '../governance-agent-credentials.js';
import { AccountRefValidationError, accountScopeFromRef } from '../account-scope.js';
import { resolveServedAdcpVersionForTool } from '../task-handlers.js';
import { toolAddedAfterRelease } from '../served-release-fields.js';
import {
  getIdempotencyStore,
  scopedPrincipal,
  validateKeyFormat,
} from '../idempotency.js';

const logger = createLogger('training-agent-custom-tool');

interface AdaptedResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

interface InlineError {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
  recovery?: string;
}

interface CustomToolOptions {
  annotations?: ToolAnnotations;
  /** The handler answers a caller whose release predates the tool with its
   * own error, so the generic release gate below stands aside. */
  gatesOwnRelease?: boolean;
  enforceIdempotency?: boolean;
  payloadErrorsAsSuccess?: boolean;
  responseSummary?: (result: Record<string, unknown>) => string | undefined;
  trainingContext?: Partial<TrainingContext>;
  resolveAuthenticatedAgentUrl?: (
    authInfo: { clientId?: string; extra?: Record<string, unknown> } | undefined,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
}

interface IdempotencyClaim {
  principal: string;
  key: string;
  payloadHash: string;
  claimToken: string;
}

/** Response roots that carry no envelope `status` (the SDK's own list). */
const STATUS_FREE_RESPONSE_TOOLS: ReadonlySet<string> = new Set([
  'list_products',
  'decline_proposals',
  'list_collections',
  'list_proposals',
]);

function toAdaptedResponse(
  toolName: string,
  result: unknown,
  callerContext: unknown,
  options: CustomToolOptions,
): AdaptedResponse {
  const errsField = (result as { errors?: unknown[] } | null | undefined)?.errors;
  const servedAdcpVersion = typeof (result as { adcp_version?: unknown } | null | undefined)?.adcp_version === 'string'
    ? (result as { adcp_version: string }).adcp_version
    : undefined;
  const canReturnPayloadErrors = options.payloadErrorsAsSuccess;
  if (Array.isArray(errsField) && errsField.length > 0 && !canReturnPayloadErrors) {
    const first = errsField[0] as InlineError;
    const errorObj: Record<string, unknown> = { code: first.code, message: first.message };
    if (first.field) errorObj.field = first.field;
    if (first.details !== undefined) errorObj.details = first.details;
    if (first.recovery) errorObj.recovery = first.recovery;
    const body = wrapEnvelope({
      adcp_error: errorObj,
      ...(servedAdcpVersion && { adcp_version: servedAdcpVersion }),
    }, { context: callerContext });
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }
  const inner = (result ?? {}) as Record<string, unknown>;
  // Custom tools bypass the SDK response pipeline that stamps the envelope
  // `status` on framework tools. Every task response envelope requires it
  // (core/protocol-envelope.json); a synchronous success is `completed`, and a
  // handler that reports another task status (an async `submitted`) keeps it.
  const withStatus = STATUS_FREE_RESPONSE_TOOLS.has(toolName) || inner.status !== undefined
    ? inner
    : { ...inner, status: 'completed' };
  const withEnvelope = wrapEnvelope(withStatus, {
    ...(callerContext !== undefined && typeof callerContext === 'object' && callerContext !== null
      ? { context: callerContext }
      : {}),
  });
  const response = withEnvelope as Record<string, unknown>;
  return {
    content: [{
      type: 'text',
      text: options.responseSummary?.(inner) ?? `${toolName} completed.`,
    }],
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

type LegacyHandler = (args: ToolArgs, ctx: TrainingContext) => object | Promise<object>;

export function deriveAccountScope(params: Record<string, unknown>): string | undefined {
  const usageAccount = Array.isArray(params.usage)
    ? (params.usage[0] as { account?: unknown } | undefined)?.account
    : undefined;
  const account = Object.prototype.hasOwnProperty.call(params, 'account')
    ? params.account
    : usageAccount;
  if (account !== undefined) return accountScopeFromRef(account);
  const domain = (params.brand as { domain?: unknown } | undefined)?.domain;
  return typeof domain === 'string' && domain.length > 0
    ? `b:${domain.toLowerCase()}`
    : undefined;
}

function idempotencyError(
  code: string,
  message: string,
  callerContext: unknown,
  options: { field?: string; recovery?: string; retry_after?: number } = {},
): AdaptedResponse {
  const errorObj: Record<string, unknown> = {
    code,
    message,
    ...(options.field && { field: options.field }),
    ...(options.recovery && { recovery: options.recovery }),
    ...(options.retry_after !== undefined && { retry_after: options.retry_after }),
  };
  const body = wrapEnvelope({ adcp_error: errorObj }, { context: callerContext });
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

async function releaseClaim(claim: IdempotencyClaim | null): Promise<void> {
  if (!claim) return;
  await getIdempotencyStore().release({
    principal: claim.principal,
    key: claim.key,
    claimToken: claim.claimToken,
  });
}

/**
 * Wrap a v5-style handler into an `AdcpCustomToolConfig` for
 * `opts.customTools` registration. Handles the `(args, ctx)` →
 * `(args, extra)` adaptation, session-context wrapping, and envelope
 * shaping.
 */
/**
 * The version envelope every AdCP request may carry. The SDK selects the
 * served release from the parsed tool arguments, and MCP input parsing drops
 * keys a tool's schema does not declare, so a custom tool that omits these
 * would always be served (and shaped) at the default release.
 */
const VERSION_ENVELOPE_SHAPE = {
  adcp_version: TOOL_REQUEST_SCHEMAS.list_accounts.shape.adcp_version,
  adcp_major_version: TOOL_REQUEST_SCHEMAS.list_accounts.shape.adcp_major_version,
} as const;

function withVersionEnvelope(
  inputSchema: Record<string, z.ZodTypeAny> | z.ZodTypeAny,
): Record<string, z.ZodTypeAny> | z.ZodTypeAny {
  if (inputSchema instanceof z.ZodObject) {
    return 'adcp_version' in inputSchema.shape ? inputSchema : inputSchema.extend(VERSION_ENVELOPE_SHAPE);
  }
  if (inputSchema instanceof z.ZodType) return inputSchema;
  return 'adcp_version' in inputSchema ? inputSchema : { ...VERSION_ENVELOPE_SHAPE, ...inputSchema };
}

export function customToolFor(
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny> | z.ZodTypeAny,
  handler: LegacyHandler,
  options: CustomToolOptions = {},
): AdcpCustomToolConfig<any, undefined> {
  return {
    description,
    inputSchema: withVersionEnvelope(inputSchema),
    ...(options.annotations ? { annotations: options.annotations } : {}),
    handler: async (args: unknown, extra: unknown) => {
      const params = (args as Record<string, unknown>) ?? {};
      const authInfo = ((extra as {
        authInfo?: { clientId?: string; extra?: Record<string, unknown> };
      } | undefined)?.authInfo) ?? undefined;
      const authenticatedAgentUrl = options.resolveAuthenticatedAgentUrl
        ? await options.resolveAuthenticatedAgentUrl(authInfo, params)
        : undefined;
      const governanceAgentCredential = governanceAgentCredentialFromExtra(authInfo?.extra);
      const hostedGraderCredential = hostedGraderCredentialFromExtra(authInfo?.extra);
      // The SDK selects the served release before it calls a custom tool and
      // passes it on `extra`, as it does on the framework tools' context.
      const servedAdcpVersion = (extra as { servedAdcpVersion?: unknown } | undefined)?.servedAdcpVersion;
      const trainingCtx: TrainingContext = {
        mode: 'open',
        principal: authInfo?.clientId ?? 'anonymous',
        ...(typeof servedAdcpVersion === 'string' && { servedAdcpVersion }),
        ...(authenticatedAgentUrl && { authenticatedAgentUrl }),
        ...(governanceAgentCredential && { governanceAgentCredential }),
        ...(hostedGraderCredential && { hostedGraderCredential }),
        ...options.trainingContext,
      };
      const { context: callerContext, ...handlerArgs } = params;
      // The SDK serves a custom tool at any release. A caller that pins a
      // release older than the tool's first defining line (search_brands and
      // list_transformers arrive in 3.1) is refused, as the SDK refuses a
      // framework tool its release does not define. The pin is resolved the
      // way the training agent resolves it, so a supported prerelease pin
      // such as 3.1-beta.5 stays on its own line.
      if (
        !options.gatesOwnRelease
        && (handlerArgs.adcp_version !== undefined || handlerArgs.adcp_major_version !== undefined)
      ) {
        const resolution = resolveServedAdcpVersionForTool(name, handlerArgs);
        if (resolution.ok && toolAddedAfterRelease(name, resolution.servedVersion)) {
          return idempotencyError(
            'VERSION_UNSUPPORTED',
            `${name} is not defined in the selected AdCP release ${resolution.servedVersion}.`,
            callerContext,
            { field: 'adcp_version', recovery: 'correctable' },
          );
        }
      }
      return runWithSessionContext(async () => {
        let claim: IdempotencyClaim | null = null;
        if (options.enforceIdempotency) {
          const idempotencyKey = (handlerArgs as { idempotency_key?: unknown }).idempotency_key;
          if (idempotencyKey === undefined || idempotencyKey === null) {
            return idempotencyError(
              'INVALID_REQUEST',
              `idempotency_key is required for ${name}. Generate a UUID v4 and include it on every mutating request; reuse the same key for network retries.`,
              callerContext,
              { field: 'idempotency_key', recovery: 'correctable' },
            );
          }
          if (!validateKeyFormat(idempotencyKey)) {
            return idempotencyError(
              'INVALID_REQUEST',
              'idempotency_key must match ^[A-Za-z0-9_.:-]{16,255}$ (UUID v4 recommended).',
              callerContext,
              { field: 'idempotency_key', recovery: 'correctable' },
            );
          }
          let accountScope: string | undefined;
          try {
            accountScope = deriveAccountScope(handlerArgs);
          } catch (err) {
            if (!(err instanceof AccountRefValidationError)) throw err;
            return idempotencyError(
              'INVALID_REQUEST',
              err.message,
              callerContext,
              { field: err.field, recovery: 'correctable' },
            );
          }
          const principal = scopedPrincipal(trainingCtx.principal ?? 'anonymous', accountScope);
          const outcome = await getIdempotencyStore().check({
            principal,
            key: idempotencyKey,
            payload: handlerArgs,
          });
          if (outcome.kind === 'expired') {
            return idempotencyError(
              'IDEMPOTENCY_EXPIRED',
              'idempotency_key is past the replay window. Generate a fresh UUID v4 and resend.',
              callerContext,
              { recovery: 'correctable' },
            );
          }
          if (outcome.kind === 'conflict') {
            return idempotencyError(
              'IDEMPOTENCY_CONFLICT',
              'idempotency_key was used with a different payload within the replay window. Either resend the exact original payload (to return the cached response) or generate a fresh UUID v4 to submit this new payload.',
              callerContext,
            );
          }
          if (outcome.kind === 'in-flight') {
            return idempotencyError(
              'IDEMPOTENCY_IN_FLIGHT',
              'A concurrent request with this idempotency_key is already in progress. Retry after a short delay.',
              callerContext,
              { recovery: 'transient', retry_after: outcome.retryAfterSeconds },
            );
          }
          if (outcome.kind === 'replay') {
            const replayed: Record<string, unknown> = { ...(outcome.response as Record<string, unknown>), replayed: true };
            if (replayed.status === undefined) replayed.status = 'completed';
            return toAdaptedResponse(
              name,
              projectTaskOutcomeForRelease(name, replayed, trainingCtx.servedAdcpVersion),
              callerContext,
              options,
            );
          }
          claim = {
            principal,
            key: idempotencyKey,
            payloadHash: outcome.payloadHash,
            claimToken: outcome.claimToken,
          };
        }
        let result: unknown;
        try {
          result = await Promise.resolve(handler(handlerArgs as ToolArgs, trainingCtx));
        } catch (err) {
          await releaseClaim(claim);
          logger.error({ err, tool: name }, 'custom-tool handler threw');
          return serviceUnavailable(err, callerContext);
        }
        try {
          await flushDirtySessions();
        } catch (err) {
          await releaseClaim(claim);
          logger.error({ err, tool: name }, 'custom-tool flushDirtySessions threw');
          return serviceUnavailable(err, callerContext);
        }
        // The cache keeps the release-neutral result; the response is shaped
        // for this caller's served release.
        const response = toAdaptedResponse(
          name,
          projectTaskOutcomeForRelease(name, result, trainingCtx.servedAdcpVersion),
          callerContext,
          options,
        );
        if (claim) {
          const hasPayloadErrors = Array.isArray((result as { errors?: unknown[] } | null | undefined)?.errors)
            && ((result as { errors?: unknown[] }).errors ?? []).length > 0;
          // A `kind: failed` result (for example a stale-version CONFLICT) is not
          // a completed operation: release the claim so a retry with the same
          // key and body re-executes instead of replaying the failure.
          const failedResult = (result as { result?: { kind?: unknown } } | null | undefined)?.result?.kind === 'failed';
          if (!response.isError && !hasPayloadErrors && !failedResult) {
            await getIdempotencyStore().save({
              principal: claim.principal,
              key: claim.key,
              payloadHash: claim.payloadHash,
              response: result as Record<string, unknown>,
              claimToken: claim.claimToken,
            });
          } else {
            await releaseClaim(claim);
          }
        }
        return response;
      });
    },
  };
}
