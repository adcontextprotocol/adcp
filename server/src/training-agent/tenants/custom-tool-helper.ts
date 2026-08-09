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
import type { AdcpCustomToolConfig } from '@adcp/sdk/server';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../logger.js';
import { runWithSessionContext, flushDirtySessions } from '../state.js';
import type { ToolArgs, TrainingContext } from '../types.js';
import { AccountRefValidationError, accountScopeFromRef } from '../account-scope.js';
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
  enforceIdempotency?: boolean;
  payloadErrorsAsSuccess?: boolean;
  responseSummary?: (result: Record<string, unknown>) => string | undefined;
  trainingContext?: Partial<TrainingContext>;
}

interface IdempotencyClaim {
  principal: string;
  key: string;
  payloadHash: string;
  claimToken: string;
}

function toAdaptedResponse(result: unknown, callerContext: unknown, options: CustomToolOptions): AdaptedResponse {
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
  const withEnvelope = wrapEnvelope(inner, {
    ...(callerContext !== undefined && typeof callerContext === 'object' && callerContext !== null
      ? { context: callerContext }
      : {}),
  });
  const response = withEnvelope as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: options.responseSummary?.(inner) ?? JSON.stringify(response) }],
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
export function customToolFor(
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny> | z.ZodTypeAny,
  handler: LegacyHandler,
  options: CustomToolOptions = {},
): AdcpCustomToolConfig<any, undefined> {
  return {
    description,
    inputSchema,
    ...(options.annotations ? { annotations: options.annotations } : {}),
    handler: async (args: unknown, extra: unknown) => {
      const params = (args as Record<string, unknown>) ?? {};
      const authInfo = ((extra as { authInfo?: { clientId?: string } } | undefined)?.authInfo) ?? undefined;
      const trainingCtx: TrainingContext = {
        mode: 'open',
        principal: authInfo?.clientId ?? 'anonymous',
        ...options.trainingContext,
      };
      const { context: callerContext, ...handlerArgs } = params;
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
            return toAdaptedResponse(replayed, callerContext, options);
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
        const response = toAdaptedResponse(result, callerContext, options);
        if (claim) {
          const hasPayloadErrors = Array.isArray((result as { errors?: unknown[] } | null | undefined)?.errors)
            && ((result as { errors?: unknown[] }).errors ?? []).length > 0;
          if (!response.isError && !hasPayloadErrors) {
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
