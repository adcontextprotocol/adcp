import { createLogger } from '../../logger.js';
import { notifyToolError } from '../error-notifier.js';
import {
  extractMultimodalContent,
  isAllowedImageType,
  isMultimodalContent,
  type FileReadResult,
} from '../mcp/url-tools.js';
import { ToolError } from '../tool-error.js';
import {
  isToolResultError,
  normalizeToolError,
  normalizeToolResult,
  type NormalizedToolResult,
  type ToolHandlerResult,
  type ToolResultPresentation,
} from '../tool-result-contract.js';
import type { AddieTool } from '../types.js';
import type {
  ModelToolCallContent,
  ModelToolResultContent,
} from './model-provider.js';

const logger = createLogger('addie-tool-orchestration');
const definitionSnapshots = new WeakMap<AddieTool, AddieTool>();

export const BLOCKED_TOOL_RESULT = 'Error: Tool execution blocked by policy';

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolHandlerResult>;
export type AddieExecutionMode = 'production' | 'evaluation' | 'replay';

export interface ToolExecutionPolicyRequest {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  tool?: Readonly<AddieTool>;
  executionMode: AddieExecutionMode;
}

export interface ToolExecutionPolicyDecision {
  allowed: boolean;
}

/** Fail closed: only an explicit `{ allowed: true }` dispatches a handler. */
export type ToolExecutionPolicy = (
  request: ToolExecutionPolicyRequest,
) => ToolExecutionPolicyDecision | Promise<ToolExecutionPolicyDecision>;

export interface ToolExecution {
  tool_name: string;
  parameters: Record<string, unknown>;
  result: string;
  result_summary?: string;
  is_error: boolean;
  duration_ms: number;
  sequence: number;
  blocked_by_policy?: true;
  normalized_result?: ToolResultPresentation;
}

export interface ToolExecutionNotificationContext {
  slackUserId?: string;
  userDisplayName?: string;
  threadId?: string;
}

export interface AddieToolExecutorOptions {
  executionMode: AddieExecutionMode;
  policy?: ToolExecutionPolicy;
  notificationContext?: ToolExecutionNotificationContext;
}

export interface AddieToolCallResult {
  result: ModelToolResultContent;
  execution: ToolExecution;
}

interface RegisteredTool {
  definition: AddieTool;
  handler?: ToolHandler;
}

function isEvaluationExecution(mode: AddieExecutionMode): boolean {
  return mode === 'evaluation' || mode === 'replay';
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotDefinition(source: AddieTool): AddieTool {
  const cached = definitionSnapshots.get(source);
  if (cached) return cached;
  const snapshot = deepFreeze(structuredClone(source));
  definitionSnapshots.set(source, snapshot);
  return snapshot;
}

function recordedParameters(
  mode: AddieExecutionMode,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return isEvaluationExecution(mode) ? {} : structuredClone(input);
}

function recordedResult(
  mode: AddieExecutionMode,
  result: string,
  kind: 'success' | 'error' | 'blocked',
): string {
  if (!isEvaluationExecution(mode)) return result;
  if (kind === 'blocked') return BLOCKED_TOOL_RESULT;
  return kind === 'error' ? 'Error: Tool execution failed' : 'Tool execution completed';
}

function recordedPresentation(
  mode: AddieExecutionMode,
  normalized: NormalizedToolResult,
): ToolResultPresentation {
  if (!isEvaluationExecution(mode)) return normalized.presentation;
  return {
    status: normalized.status,
    user_summary: isToolResultError(normalized.status)
      ? 'Tool execution failed'
      : 'Tool execution completed',
    source: normalized.presentation.source,
  };
}

function observeNormalizedToolResult(
  toolName: string,
  normalized: NormalizedToolResult,
): NormalizedToolResult {
  if (normalized.display_degradation) {
    logger.warn({
      event: 'addie_tool_result_display_degraded',
      toolName,
      reason: normalized.display_degradation,
    }, 'Addie: Tool result display payload degraded; text result preserved');
  }
  if (normalized.model_context_truncated || normalized.user_summary_truncated) {
    logger.warn({
      event: 'addie_tool_result_content_bounded',
      toolName,
      modelContextTruncated: normalized.model_context_truncated,
      userSummaryTruncated: normalized.user_summary_truncated,
    }, 'Addie: Oversized tool result content bounded');
  }
  return normalized;
}

function summarizeLegacyToolResult(toolName: string, result: string): string {
  if (toolName === 'search_docs') {
    const match = result.match(/Found (\d+) documentation pages/);
    if (match) return `Found ${match[1]} doc page(s)`;
    if (result.includes('No documentation found')) return 'No docs found';
  }
  if (toolName === 'search_slack') {
    const match = result.match(/Found (\d+) Slack messages/);
    if (match) return `Found ${match[1]} Slack message(s)`;
    if (result.includes('No Slack discussions found')) return 'No Slack results';
  }
  if (toolName === 'web_search') return result;
  return result.length > 100 ? `${result.substring(0, 97)}...` : result;
}

function buildMultimodalContent(
  multimodal: FileReadResult,
): { content: ModelToolResultContent['content']; summary: string } | null {
  if (!multimodal.data) return null;

  if (multimodal.type === 'image') {
    if (!isAllowedImageType(multimodal.media_type)) {
      logger.warn(
        { mediaType: multimodal.media_type },
        'Addie: Invalid image media type in multimodal content',
      );
      return null;
    }
    return {
      content: [
        { type: 'image', mediaType: multimodal.media_type, data: multimodal.data },
        { type: 'text', text: `[Image: ${multimodal.filename || 'uploaded image'}]` },
      ],
      summary: `Loaded image: ${multimodal.filename || 'file'}`,
    };
  }

  if (multimodal.type === 'document') {
    return {
      content: [
        { type: 'document', mediaType: 'application/pdf', data: multimodal.data },
        { type: 'text', text: `[PDF Document: ${multimodal.filename || 'uploaded document'}]` },
      ],
      summary: `Loaded document: ${multimodal.filename || 'file'}`,
    };
  }
  return null;
}

function failureResult(
  call: ModelToolCallContent,
  sequence: number,
  mode: AddieExecutionMode,
  normalized: NormalizedToolResult,
  durationMs: number,
  blockedByPolicy = false,
): AddieToolCallResult {
  const presentation = recordedPresentation(mode, normalized);
  const resultText = recordedResult(
    mode,
    normalized.model_context,
    blockedByPolicy ? 'blocked' : 'error',
  );
  return {
    result: {
      type: 'tool_result',
      toolCallId: call.id,
      toolName: call.name,
      content: normalized.model_context,
      isError: true,
    },
    execution: {
      tool_name: call.name,
      parameters: recordedParameters(mode, call.input),
      result: resultText,
      result_summary: blockedByPolicy
        ? 'Blocked by tool execution policy'
        : presentation.user_summary,
      is_error: true,
      duration_ms: blockedByPolicy ? 0 : durationMs,
      sequence,
      ...(blockedByPolicy && { blocked_by_policy: true as const }),
      normalized_result: presentation,
    },
  };
}

/**
 * Return the common, provider-neutral custom-tool execution boundary used by
 * live model loops. Definitions remain canonical JSON Schema at the model
 * boundary, while handlers retain their established tolerant input coercion.
 */
export function createAddieToolExecutor(
  tools: readonly AddieTool[],
  handlers: ReadonlyMap<string, ToolHandler>,
  options: AddieToolExecutorOptions,
): (call: ModelToolCallContent, sequence: number) => Promise<AddieToolCallResult> {
  const registry = new Map<string, RegisteredTool>();
  for (const sourceDefinition of tools) {
    const definition = snapshotDefinition(sourceDefinition);
    registry.set(definition.name, {
      definition,
      handler: handlers.get(definition.name),
    });
  }

  return async (sourceCall, sequence) => {
    const clonedInput: unknown = structuredClone(sourceCall.input);
    const inputIsObject = typeof clonedInput === 'object'
      && clonedInput !== null
      && !Array.isArray(clonedInput);
    const call: ModelToolCallContent = Object.freeze({
      ...sourceCall,
      input: deepFreeze(
        (inputIsObject ? clonedInput : {}) as ModelToolCallContent['input'],
      ),
    });
    const startTime = Date.now();
    const operationalExecution = options.executionMode === 'production';
    const registered = registry.get(call.name);
    if (!registered?.handler) {
      const normalized = observeNormalizedToolResult(
        call.name,
        normalizeToolError(call.name, new Error(`Unknown tool "${call.name}"`), { expected: false }),
      );
      return failureResult(
        call,
        sequence,
        options.executionMode,
        normalized,
        Date.now() - startTime,
      );
    }

    // Provider adapters guarantee a JSON object for canonical tool calls. Keep
    // this runtime guard for malformed/synthetic callers, but do not enforce
    // the advertised JSON Schema here: several long-lived handlers
    // intentionally coerce recoverable model drift (for example a comma-
    // separated string where an array of strings was requested).
    if (!inputIsObject) {
      const normalized = observeNormalizedToolResult(call.name, normalizeToolResult(call.name, {
        status: 'invalid_input',
        model_context: 'Error: Tool input did not match the required JSON Schema',
        user_summary: 'The tool received invalid input.',
      }));
      return failureResult(
        call,
        sequence,
        options.executionMode,
        normalized,
        Date.now() - startTime,
      );
    }

    let allowed = !isEvaluationExecution(options.executionMode);
    if (options.policy) {
      try {
        const decision = await options.policy({
          toolName: call.name,
          input: call.input,
          tool: registered.definition,
          executionMode: options.executionMode,
        });
        allowed = decision?.allowed === true;
      } catch {
        logger.warn(
          { toolName: call.name, executionMode: options.executionMode },
          'Addie: Tool execution policy failed closed',
        );
        allowed = false;
      }
    }
    if (!allowed) {
      const normalized = observeNormalizedToolResult(call.name, normalizeToolResult(call.name, {
        status: 'access_denied',
        model_context: BLOCKED_TOOL_RESULT,
        user_summary: 'This tool action was blocked by execution policy.',
      }));
      return failureResult(call, sequence, options.executionMode, normalized, 0, true);
    }

    try {
      const handlerResult = await registered.handler(structuredClone(call.input));
      const durationMs = Date.now() - startTime;
      if (typeof handlerResult === 'string' && isMultimodalContent(handlerResult)) {
        const multimodal = extractMultimodalContent(handlerResult);
        const converted = multimodal ? buildMultimodalContent(multimodal) : null;
        if (!converted) {
          const normalized = observeNormalizedToolResult(
            call.name,
            normalizeToolError(call.name, new Error('Failed to process file content'), { expected: false }),
          );
          return failureResult(call, sequence, options.executionMode, normalized, durationMs);
        }
        const normalized = observeNormalizedToolResult(call.name, normalizeToolResult(call.name, {
          status: 'ok',
          model_context: converted.summary,
          user_summary: converted.summary,
        }));
        const presentation = recordedPresentation(options.executionMode, normalized);
        logger.info({
          toolName: call.name,
          multimodalType: multimodal?.type,
          ...(operationalExecution && { filename: multimodal?.filename }),
        }, 'Addie: Processed multimodal tool result');
        return {
          result: {
            type: 'tool_result',
            toolCallId: call.id,
            toolName: call.name,
            content: converted.content,
          },
          execution: {
            tool_name: call.name,
            parameters: recordedParameters(options.executionMode, call.input),
            result: recordedResult(options.executionMode, converted.summary, 'success'),
            result_summary: recordedResult(options.executionMode, converted.summary, 'success'),
            is_error: false,
            duration_ms: durationMs,
            sequence,
            normalized_result: presentation,
          },
        };
      }

      const normalized = observeNormalizedToolResult(
        call.name,
        normalizeToolResult(call.name, handlerResult),
      );
      const presentation = recordedPresentation(options.executionMode, normalized);
      const isError = isToolResultError(normalized.status);
      const summary = normalized.presentation.source === 'legacy' && typeof handlerResult === 'string'
        ? summarizeLegacyToolResult(call.name, handlerResult)
        : presentation.user_summary;
      return {
        result: {
          type: 'tool_result',
          toolCallId: call.id,
          toolName: call.name,
          content: normalized.model_context,
          ...(isError && { isError: true }),
        },
        execution: {
          tool_name: call.name,
          parameters: recordedParameters(options.executionMode, call.input),
          result: recordedResult(options.executionMode, normalized.model_context, isError ? 'error' : 'success'),
          result_summary: recordedResult(options.executionMode, summary, isError ? 'error' : 'success'),
          is_error: isError,
          duration_ms: durationMs,
          sequence,
          normalized_result: presentation,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isExpected = error instanceof ToolError;
      const normalized = observeNormalizedToolResult(
        call.name,
        normalizeToolError(call.name, error, { expected: isExpected }),
      );
      if (isExpected) {
        logger.warn({
          toolName: call.name,
          ...(operationalExecution && { toolInput: call.input, error: errorMessage }),
          durationMs,
        }, 'Addie: Tool returned expected error');
      } else {
        logger.error({
          toolName: call.name,
          ...(operationalExecution && { toolInput: call.input, error: errorMessage }),
          durationMs,
        }, 'Addie: Tool threw unexpected exception');
        if (operationalExecution) {
          notifyToolError({
            toolName: call.name,
            errorMessage,
            toolInput: call.input,
            slackUserId: options.notificationContext?.slackUserId,
            userDisplayName: options.notificationContext?.userDisplayName,
            threadId: options.notificationContext?.threadId,
            threw: true,
          });
        }
      }
      return failureResult(call, sequence, options.executionMode, normalized, durationMs);
    }
  };
}
