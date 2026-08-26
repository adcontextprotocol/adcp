import Ajv, { type ValidateFunction } from 'ajv';
import { collectModelResponse } from './events.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelRespondOptions,
  ModelToolDefinition,
  ModelUsage,
} from './model-provider.js';

const MAX_ITERATIONS = 2;
const MAX_TOOL_CALLS = 1;
const MAX_TOOL_RESULT_BYTES = 128 * 1024;

export type ReadOnlyToolLoopReason =
  | 'unsafe_tool_classification'
  | 'duplicate_tool_definition'
  | 'preexisting_tool_state'
  | 'provider_tool_not_allowed'
  | 'unknown_tool_call'
  | 'duplicate_tool_call'
  | 'tool_input_invalid'
  | 'tool_schema_invalid'
  | 'tool_policy_unavailable'
  | 'tool_policy_rejected'
  | 'tool_call_limit_exceeded'
  | 'tool_result_invalid'
  | 'iteration_limit_exceeded'
  | 'provider_continuation_not_allowed';

export class ReadOnlyToolLoopBoundaryError extends Error {
  constructor(readonly reason: ReadOnlyToolLoopReason) {
    super(reason);
    this.name = 'ReadOnlyToolLoopBoundaryError';
  }
}

export interface ReadOnlyModelTool {
  definition: ModelToolDefinition;
  replaySafety: string | undefined;
  handler(input: Readonly<Record<string, unknown>>): Promise<string>;
}

export interface ReadOnlyToolExecutionReceipt {
  sequence: number;
  toolName: string;
  disposition: 'succeeded' | 'handler_error';
}

export interface ReadOnlyToolLoopResult {
  response: ModelResponse;
  text: string;
  iterations: number;
  usage: ModelUsage;
  toolExecutions: ReadonlyArray<ReadOnlyToolExecutionReceipt>;
}

export interface ReadOnlyToolAuthorizationInput {
  toolCallId: string;
  toolName: string;
  toolInput: Readonly<Record<string, unknown>>;
  replaySafety: 'pure_local';
  definition: ModelToolDefinition;
  handler: ReadOnlyModelTool['handler'];
}

export interface ReadOnlyToolLoopOptions {
  signal?: AbortSignal;
  beforeDispatch?: ModelRespondOptions['beforeDispatch'];
  authorizeToolExecution?: (
    input: Readonly<ReadOnlyToolAuthorizationInput>,
  ) => { allowed: true } | { allowed: false } | Promise<{ allowed: true } | { allowed: false }>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function addUsage(total: ModelUsage, usage: ModelUsage): ModelUsage {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    ...(total.cacheWriteTokens !== undefined || usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0) }
      : {}),
    ...(total.cacheReadTokens !== undefined || usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0) }
      : {}),
  };
}

function responseText(response: ModelResponse): string {
  return response.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

/**
 * Execute a provider-neutral, retry-free tool loop for explicitly classified
 * local reads. This is intentionally narrower than Addie's production loop:
 * no provider tools, mutations, principal data, fallback, or user delivery.
 */
export async function executeReadOnlyToolLoop(
  provider: ModelProvider,
  initialRequest: ModelRequest,
  tools: ReadonlyArray<ReadOnlyModelTool>,
  options: ReadOnlyToolLoopOptions = {},
): Promise<ReadOnlyToolLoopResult> {
  const requestSnapshot = deepFreeze(structuredClone(initialRequest));
  if (requestSnapshot.tools.length > 0) {
    throw new ReadOnlyToolLoopBoundaryError('duplicate_tool_definition');
  }
  if ((requestSnapshot.providerTools?.length ?? 0) > 0) {
    throw new ReadOnlyToolLoopBoundaryError('provider_tool_not_allowed');
  }
  if (!options.authorizeToolExecution) {
    throw new ReadOnlyToolLoopBoundaryError('tool_policy_unavailable');
  }
  if (requestSnapshot.messages.some((message) => message.content.some(
    (content) => content.type !== 'text' && content.type !== 'image' && content.type !== 'document',
  ))) {
    throw new ReadOnlyToolLoopBoundaryError('preexisting_tool_state');
  }

  const ajv = new Ajv({ allErrors: false, strict: false });
  const byName = new Map<string, { tool: ReadOnlyModelTool; validate: ValidateFunction }>();
  const snapshotTools: ReadOnlyModelTool[] = [];
  for (const sourceTool of tools) {
    const tool = Object.freeze({
      definition: deepFreeze(structuredClone(sourceTool.definition)),
      replaySafety: sourceTool.replaySafety,
      handler: sourceTool.handler,
    });
    if (tool.replaySafety !== 'pure_local') {
      throw new ReadOnlyToolLoopBoundaryError('unsafe_tool_classification');
    }
    if (byName.has(tool.definition.name)) {
      throw new ReadOnlyToolLoopBoundaryError('duplicate_tool_definition');
    }
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(tool.definition.inputSchema);
    } catch {
      throw new ReadOnlyToolLoopBoundaryError('tool_schema_invalid');
    }
    byName.set(tool.definition.name, { tool, validate });
    snapshotTools.push(tool);
  }
  if (byName.size < 1) throw new ReadOnlyToolLoopBoundaryError('unknown_tool_call');

  let messages = [...requestSnapshot.messages];
  let totalUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  const receipts: ReadOnlyToolExecutionReceipt[] = [];
  const seenCallIds = new Set<string>();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const request: ModelRequest = {
      ...requestSnapshot,
      messages,
      tools: snapshotTools.map((tool) => tool.definition),
      providerTools: [],
    };
    const response = await collectModelResponse(provider.respond(request, {
      signal: options.signal,
      beforeDispatch: options.beforeDispatch,
    }), provider.id);
    totalUsage = addUsage(totalUsage, response.usage);

    const calls = response.content.filter((content) => content.type === 'tool_call');
    const unsupportedContinuation = response.content.some((content) =>
      content.type === 'provider_tool_call' || content.type === 'provider_tool_result');
    if (unsupportedContinuation) {
      throw new ReadOnlyToolLoopBoundaryError('provider_continuation_not_allowed');
    }
    if (calls.length === 0) {
      if (response.finishReason === 'continue') {
        messages = [...messages, { role: 'assistant', content: response.content }];
        continue;
      }
      return {
        response,
        text: responseText(response),
        iterations: iteration,
        usage: totalUsage,
        toolExecutions: Object.freeze([...receipts]),
      };
    }

    if (receipts.length + calls.length > MAX_TOOL_CALLS) {
      throw new ReadOnlyToolLoopBoundaryError('tool_call_limit_exceeded');
    }
    const validatedCalls = calls.map((call) => Object.freeze({
      id: call.id,
      name: call.name,
      input: deepFreeze(structuredClone(call.input)),
    }));
    for (const call of validatedCalls) {
      if (seenCallIds.has(call.id)) {
        throw new ReadOnlyToolLoopBoundaryError('duplicate_tool_call');
      }
      const registered = byName.get(call.name);
      if (!registered) {
        throw new ReadOnlyToolLoopBoundaryError('unknown_tool_call');
      }
      if (!registered.validate(call.input)) {
        throw new ReadOnlyToolLoopBoundaryError('tool_input_invalid');
      }
    }

    const results = [];
    for (const call of validatedCalls) {
      seenCallIds.add(call.id);
      const tool = byName.get(call.name)!.tool;
      let authorization: { allowed: true } | { allowed: false };
      try {
        authorization = await options.authorizeToolExecution(Object.freeze({
          toolCallId: call.id,
          toolName: call.name,
          toolInput: call.input,
          replaySafety: 'pure_local',
          definition: tool.definition,
          handler: tool.handler,
        }));
      } catch {
        throw new ReadOnlyToolLoopBoundaryError('tool_policy_rejected');
      }
      if (
        typeof authorization !== 'object'
        || authorization === null
        || Object.keys(authorization).length !== 1
        || authorization.allowed !== true
      ) throw new ReadOnlyToolLoopBoundaryError('tool_policy_rejected');
      let content: string;
      let isError = false;
      try {
        content = await tool.handler(call.input);
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TOOL_RESULT_BYTES) {
          throw new ReadOnlyToolLoopBoundaryError('tool_result_invalid');
        }
      } catch (error) {
        if (error instanceof ReadOnlyToolLoopBoundaryError) throw error;
        content = 'Tool execution failed.';
        isError = true;
      }
      receipts.push(Object.freeze({
        sequence: receipts.length + 1,
        toolName: call.name,
        disposition: isError ? 'handler_error' : 'succeeded',
      }));
      results.push({
        type: 'tool_result' as const,
        toolCallId: call.id,
        toolName: call.name,
        content,
        ...(isError && { isError: true }),
      });
    }
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: results },
    ];
  }

  throw new ReadOnlyToolLoopBoundaryError('iteration_limit_exceeded');
}
