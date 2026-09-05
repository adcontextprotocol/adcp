import type { CreateMessageInput } from './thread-service.js';
import type {
  ToolExecution,
  ToolExecutionPolicy,
} from './model-providers/tool-orchestration.js';

export interface StoredToolCall {
  name: string;
  input: unknown;
  result: unknown;
  duration_ms?: number;
  is_error?: boolean;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function replayKey(toolName: string, input: unknown): string {
  return `${toolName}\0${canonicalJson(input)}`;
}

export function storedToolCall(execution: ToolExecution): StoredToolCall {
  return {
    name: execution.tool_name,
    input: execution.parameters,
    result: execution.result,
    duration_ms: execution.duration_ms,
    is_error: execution.is_error,
  };
}

/**
 * Build one hidden assistant row containing exactly one completed tool-use /
 * tool-result pair. The row is intentionally marked interrupted: a later
 * completed assistant response supersedes it, while an interrupted turn can
 * reconstruct the pair without retaining partial prose.
 */
export function buildToolResultCheckpoint(input: {
  threadId: string;
  execution: ToolExecution;
  requestedModel: string;
  clientRequestId?: string;
}): CreateMessageInput {
  return {
    thread_id: input.threadId,
    role: 'assistant',
    content: '',
    tools_used: [input.execution.tool_name],
    tool_calls: [storedToolCall(input.execution)],
    model: input.requestedModel,
    model_execution: {
      source: 'local',
      requested_provider: 'anthropic',
      requested_model: input.requestedModel,
      reason: 'stream_interrupted',
    },
    delivery_status: 'interrupted',
    ...(input.clientRequestId && { client_request_id: input.clientRequestId }),
  };
}

/**
 * Prevent an interrupted-turn retry from dispatching an exact tool call whose
 * result is already present in model history. Non-matching calls still pass
 * through the caller's existing policy (or are allowed when no policy exists).
 */
export function blockCheckpointedToolReplays(
  checkpoints: readonly StoredToolCall[],
  delegate?: ToolExecutionPolicy,
): ToolExecutionPolicy | undefined {
  if (checkpoints.length === 0) return delegate;
  // A failed tool result is useful model context, but it is not an irreversible
  // action receipt. Let the normal policy decide whether a later attempt may
  // retry it.
  const completed = new Set(
    checkpoints
      .filter((call) => call.is_error !== true)
      .map((call) => replayKey(call.name, call.input)),
  );
  if (completed.size === 0) return delegate;
  return async (request) => {
    if (completed.has(replayKey(request.toolName, request.input))) return { allowed: false };
    return delegate ? delegate(request) : { allowed: true };
  };
}
