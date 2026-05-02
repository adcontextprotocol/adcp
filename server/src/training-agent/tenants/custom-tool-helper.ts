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
import { createLogger } from '../../logger.js';
import { runWithSessionContext, flushDirtySessions } from '../state.js';
import type { ToolArgs, TrainingContext } from '../types.js';

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

type LegacyHandler = (args: ToolArgs, ctx: TrainingContext) => object | Promise<object>;

/**
 * Wrap a v5-style handler into an `AdcpCustomToolConfig` for
 * `opts.customTools` registration. Handles the `(args, ctx)` →
 * `(args, extra)` adaptation, session-context wrapping, and envelope
 * shaping.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function customToolFor(name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: LegacyHandler): AdcpCustomToolConfig<any, undefined> {
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
          logger.error({ err, tool: name }, 'custom-tool handler threw');
          return serviceUnavailable(err, callerContext);
        }
        try {
          await flushDirtySessions();
        } catch (err) {
          logger.error({ err, tool: name }, 'custom-tool flushDirtySessions threw');
          return serviceUnavailable(err, callerContext);
        }
        return toAdaptedResponse(result, callerContext);
      });
    },
  };
}
