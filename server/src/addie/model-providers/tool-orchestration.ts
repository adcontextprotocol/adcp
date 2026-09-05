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
  renderToolResultForModel,
  type NormalizedToolResult,
  type ToolHandlerResult,
  type ToolResultPresentation,
} from '../tool-result-contract.js';
import type { AddieTool } from '../types.js';
import type {
  ModelMessage,
  ModelProvider,
  ModelProviderToolCallContent,
  ModelProviderToolReceipt,
  ModelProviderToolResultContent,
  ModelToolCallContent,
  ModelToolResultContent,
} from './model-provider.js';
import {
  appendModelTurnContinuation,
  type AcceptedModelTurn,
  type EmptyResponseRecoveryEligibility,
  type EmptyResponseRecoveryKind,
  type ModelTurnAction,
  type ModelTurnLoopState,
} from './model-turn.js';

const logger = createLogger('addie-tool-orchestration');
const definitionSnapshots = new WeakMap<AddieTool, AddieTool>();

export const BLOCKED_TOOL_RESULT = 'Error: Tool execution blocked by policy';

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolHandlerResult>;
export type AddieExecutionMode = 'production' | 'evaluation' | 'replay' | 'shadow';

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

export type AddieToolExecutor = (
  call: ModelToolCallContent,
  sequence: number,
) => Promise<AddieToolCallResult>;

export type AddieToolExecutionEvent =
  | {
      type: 'start';
      call: ModelToolCallContent;
      sequence: number;
    }
  | {
      type: 'end';
      call: ModelToolCallContent;
      sequence: number;
      executed: AddieToolCallResult;
    };

export interface AddieProviderToolExecution {
  result: ModelProviderToolResultContent;
  receipt: ModelProviderToolReceipt;
  execution: ToolExecution;
}

export interface AddieAcceptedTurnDecision {
  disposition: AddieAcceptedTurnDisposition;
  text: string;
  hasCustomToolCalls: boolean;
}

export type AddieAcceptedTurnDisposition =
  | Readonly<{
      type: 'continue';
      reason: Extract<ModelTurnAction, 'execute_tools' | 'continue' | 'continue_provider_tools'>;
    }>
  | Readonly<{
      type: 'recover';
      reason: EmptyResponseRecoveryKind;
    }>
  | Readonly<{
      type: 'terminal';
      reason: Extract<ModelTurnAction, 'complete' | 'truncated'>;
    }>;

export type AddieAcceptedTurnEvent =
  | { type: 'provider_tool'; recorded: AddieProviderToolExecution }
  | AddieToolExecutionEvent
  | { type: 'turn_decision'; decision: AddieAcceptedTurnDecision };

export interface OrchestrateAcceptedAddieTurnOptions {
  turn: AcceptedModelTurn;
  provider: Pick<ModelProvider, 'id' | 'deriveProviderToolReceipt'>;
  executionMode: AddieExecutionMode;
  messages: ModelMessage[];
  ledger: AddieToolExecutionLedger;
  execute: AddieToolExecutor;
  emptyResponseRecovery: {
    loop: Pick<ModelTurnLoopState, 'scheduleEmptyResponseRecovery'>;
    deliverableText: string;
    eligibility: EmptyResponseRecoveryEligibility;
  };
}

/**
 * Canonical execution ledger shared by delivery adapters. It owns tool order,
 * global sequence numbering, and completed execution history while callers
 * retain control of delivery-specific logs and stream events.
 */
export class AddieToolExecutionLedger {
  private currentSequence = 0;
  private pendingCustomSequence: number | null = null;
  private readonly usedToolNames: string[] = [];
  private readonly completedExecutions: ToolExecution[] = [];

  get sequence(): number {
    return this.currentSequence;
  }

  get toolsUsed(): readonly string[] {
    return this.usedToolNames;
  }

  get executions(): readonly ToolExecution[] {
    return this.completedExecutions;
  }

  recordProviderResults(
    provider: Pick<ModelProvider, 'id' | 'deriveProviderToolReceipt'>,
    calls: readonly ModelProviderToolCallContent[],
    results: readonly ModelProviderToolResultContent[],
    executionMode: AddieExecutionMode,
  ): AddieProviderToolExecution[] {
    if (this.pendingCustomSequence !== null) {
      throw new Error('Cannot record provider tools during a custom-tool execution');
    }
    const recorded = recordProviderToolResults(provider, calls, results, {
      executionMode,
      startingSequence: this.currentSequence,
    });
    for (const entry of recorded) {
      if (entry.execution.sequence !== this.currentSequence + 1) {
        throw new Error('Provider tool execution sequence is not contiguous');
      }
      this.currentSequence = entry.execution.sequence;
      this.usedToolNames.push(entry.execution.tool_name);
      this.completedExecutions.push(entry.execution);
    }
    return recorded;
  }

  async *executeCustomCalls(
    calls: readonly ModelToolCallContent[],
    execute: AddieToolExecutor,
    turnResults: ModelToolResultContent[],
  ): AsyncGenerator<AddieToolExecutionEvent> {
    for await (const event of executeAddieToolCalls(calls, execute, this.currentSequence)) {
      this.recordCustomEvent(event, turnResults);
      yield event;
    }
  }

  private recordCustomEvent(
    event: AddieToolExecutionEvent,
    turnResults: ModelToolResultContent[],
  ): void {
    if (event.type === 'start') {
      if (this.pendingCustomSequence !== null) {
        throw new Error('Previous custom-tool execution has not completed');
      }
      if (event.sequence !== this.currentSequence + 1) {
        throw new Error('Custom-tool execution sequence is not contiguous');
      }
      this.currentSequence = event.sequence;
      this.pendingCustomSequence = event.sequence;
      this.usedToolNames.push(event.call.name);
      return;
    }

    if (
      this.pendingCustomSequence !== event.sequence
      || event.executed.execution.sequence !== event.sequence
    ) {
      throw new Error('Custom-tool completion does not match its start event');
    }
    turnResults.push(event.executed.result);
    this.completedExecutions.push(event.executed.execution);
    this.pendingCustomSequence = null;
  }
}

/**
 * Apply one accepted provider-neutral turn to Addie's shared tool and message
 * state. Delivery adapters consume the emitted events for logging/UI only;
 * this boundary owns provider receipts, sequential custom-tool execution, and
 * the exact assistant/tool-result continuation written to the next request.
 */
export async function* orchestrateAcceptedAddieTurn(
  options: OrchestrateAcceptedAddieTurnOptions,
): AsyncGenerator<AddieAcceptedTurnEvent> {
  const {
    turn,
    provider,
    executionMode,
    messages,
    ledger,
    execute,
    emptyResponseRecovery,
  } = options;

  const providerExecutions = ledger.recordProviderResults(
    provider,
    turn.providerToolCalls,
    turn.providerToolResults,
    executionMode,
  );
  for (const recorded of providerExecutions) {
    yield { type: 'provider_tool', recorded };
  }

  const text = turn.textBlocks.map((block) => block.text).join('\n\n');
  const emptyRecovery = turn.action === 'complete'
    ? emptyResponseRecovery.loop.scheduleEmptyResponseRecovery(
        turn.response,
        emptyResponseRecovery.deliverableText,
        emptyResponseRecovery.eligibility,
      )
    : null;
  const disposition: AddieAcceptedTurnDisposition = emptyRecovery
    ? Object.freeze({ type: 'recover', reason: emptyRecovery })
    : turn.action === 'complete' || turn.action === 'truncated'
      ? Object.freeze({ type: 'terminal', reason: turn.action })
      : Object.freeze({ type: 'continue', reason: turn.action });
  const decision: AddieAcceptedTurnDecision = Object.freeze({
    disposition,
    text,
    hasCustomToolCalls: turn.toolCalls.length > 0,
  });
  yield { type: 'turn_decision', decision };

  if (
    decision.disposition.type === 'continue'
    && decision.disposition.reason !== 'execute_tools'
  ) {
    appendModelTurnContinuation(messages, turn.response);
    return;
  }

  if (
    decision.disposition.type !== 'continue'
    || decision.disposition.reason !== 'execute_tools'
  ) return;

  const toolResults: ModelToolResultContent[] = [];
  for await (const event of ledger.executeCustomCalls(
    turn.toolCalls,
    execute,
    toolResults,
  )) {
    yield event;
  }
  appendModelTurnContinuation(messages, turn.response, toolResults);
}

interface RegisteredTool {
  definition: AddieTool;
  handler?: ToolHandler;
}

function isIsolatedExecution(mode: AddieExecutionMode): boolean {
  return mode === 'evaluation' || mode === 'replay' || mode === 'shadow';
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
  return isIsolatedExecution(mode) ? {} : structuredClone(input);
}

function recordedResult(
  mode: AddieExecutionMode,
  result: string,
  kind: 'success' | 'error' | 'blocked',
): string {
  if (!isIsolatedExecution(mode)) return result;
  if (kind === 'blocked') return BLOCKED_TOOL_RESULT;
  return kind === 'error' ? 'Error: Tool execution failed' : 'Tool execution completed';
}

function recordedPresentation(
  mode: AddieExecutionMode,
  normalized: NormalizedToolResult,
): ToolResultPresentation {
  if (!isIsolatedExecution(mode)) return normalized.presentation;
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

function fallbackProviderToolReceipt(
  result: ModelProviderToolResultContent,
): ModelProviderToolReceipt {
  const displayName = result.name === 'web_search'
    ? 'Web search'
    : result.name.replaceAll('_', ' ');
  const resultSummary = result.isError
    ? `${displayName} failed`
    : `${displayName} completed (${result.resultCount} results)`;
  return {
    toolCallId: result.toolCallId,
    toolName: result.name,
    parameters: {},
    resultSummary,
    resultDetails: resultSummary,
    isError: result.isError,
  };
}

/**
 * Convert completed provider-managed tool results into the same execution
 * ledger used by custom tools. Results, rather than call blocks, are the
 * authoritative execution boundary: a mixed provider/custom turn therefore
 * records each provider action exactly once, while an unfinished provider
 * call is not reported as completed.
 */
export function recordProviderToolResults(
  provider: Pick<ModelProvider, 'id' | 'deriveProviderToolReceipt'>,
  calls: readonly ModelProviderToolCallContent[],
  results: readonly ModelProviderToolResultContent[],
  options: {
    executionMode: AddieExecutionMode;
    startingSequence: number;
  },
): AddieProviderToolExecution[] {
  return results.map((result, index) => {
    if (result.provider !== provider.id) {
      throw new Error('Provider tool result does not match selected provider');
    }
    const call = calls.find((candidate) => (
      candidate.provider === provider.id
      && candidate.id === result.toolCallId
      && candidate.name === result.name
    ));
    const receipt = call && provider.deriveProviderToolReceipt
      ? provider.deriveProviderToolReceipt(
          call,
          result,
          isIsolatedExecution(options.executionMode) ? 'redacted' : 'production',
        )
      : fallbackProviderToolReceipt(result);
    const normalized = observeNormalizedToolResult(result.name, normalizeToolResult(result.name, {
      status: receipt.isError ? 'error' : result.resultCount === 0 ? 'empty' : 'ok',
      model_context: receipt.resultDetails,
      user_summary: receipt.resultSummary,
    }));
    const presentation = recordedPresentation(options.executionMode, normalized);
    const kind = receipt.isError ? 'error' : 'success';
    return {
      result,
      receipt,
      execution: {
        tool_name: receipt.toolName,
        parameters: recordedParameters(options.executionMode, receipt.parameters),
        result: recordedResult(options.executionMode, normalized.model_context, kind),
        result_summary: recordedResult(options.executionMode, presentation.user_summary, kind),
        is_error: receipt.isError,
        duration_ms: 0,
        sequence: options.startingSequence + index + 1,
        normalized_result: presentation,
      },
    };
  });
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
  const modelResult = renderToolResultForModel(call.name, normalized);
  if (modelResult.framing_truncated && !normalized.model_context_truncated) {
    logger.warn({
      event: 'addie_tool_result_content_bounded',
      toolName: call.name,
      modelContextTruncated: true,
      evidenceFraming: true,
    }, 'Addie: Tool result content bounded for evidence framing');
  }
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
      content: modelResult.content,
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
): AddieToolExecutor {
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
      const definitionPresent = Boolean(registered?.definition);
      const invariantEvent = definitionPresent
        ? 'addie_declared_tool_missing_handler'
        : 'addie_undeclared_tool_call';
      const invariantMessage = definitionPresent
        ? 'Addie: Declared request tool is missing an executable handler'
        : 'Addie: Model requested a tool outside the executable request surface';
      const invariantContext = {
        event: invariantEvent,
        toolName: call.name,
        definitionPresent,
        executableToolCount: registry.size,
        executionMode: options.executionMode,
      };
      if (operationalExecution) {
        // notifyToolError below owns the operator notification. Logging this
        // at error as well causes the logger hook to emit a duplicate system
        // alert for the same rejected call.
        logger.warn(invariantContext, invariantMessage);
      } else {
        logger.debug(invariantContext, invariantMessage);
      }
      if (operationalExecution) {
        notifyToolError({
          // Keep provider/model-controlled tool names out of Slack rendering
          // and use a stable key so arbitrary names cannot bypass throttling.
          toolName: invariantEvent,
          errorMessage: invariantMessage,
          slackUserId: options.notificationContext?.slackUserId,
          userDisplayName: options.notificationContext?.userDisplayName,
          threadId: options.notificationContext?.threadId,
          threw: false,
        });
      }
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

    let allowed = !isIsolatedExecution(options.executionMode);
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
      const modelResult = renderToolResultForModel(call.name, normalized);
      if (modelResult.framing_truncated && !normalized.model_context_truncated) {
        logger.warn({
          event: 'addie_tool_result_content_bounded',
          toolName: call.name,
          modelContextTruncated: true,
          evidenceFraming: true,
        }, 'Addie: Tool result content bounded for evidence framing');
      }
      const summary = normalized.presentation.source === 'legacy' && typeof handlerResult === 'string'
        ? summarizeLegacyToolResult(call.name, handlerResult)
        : presentation.user_summary;
      return {
        result: {
          type: 'tool_result',
          toolCallId: call.id,
          toolName: call.name,
          content: modelResult.content,
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

/**
 * Execute one canonical custom-tool turn sequentially. The shared sequence is
 * advanced before dispatch so delivery modes can emit a start event without
 * taking ownership of mutation ordering or ledger numbering.
 */
export async function* executeAddieToolCalls(
  calls: readonly ModelToolCallContent[],
  execute: AddieToolExecutor,
  startingSequence: number,
): AsyncGenerator<AddieToolExecutionEvent> {
  let sequence = startingSequence;
  for (const call of calls) {
    sequence++;
    yield Object.freeze({ type: 'start', call, sequence });
    const executed = await execute(call, sequence);
    yield Object.freeze({ type: 'end', call, sequence, executed });
  }
}
