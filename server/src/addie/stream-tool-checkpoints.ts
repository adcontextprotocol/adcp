import type { ModelProviderId } from './model-providers/model-provider.js';
import type { CreateMessageInput, ThreadService } from './thread-service.js';
import type {
  ToolExecution,
  ToolExecutionPolicy,
} from './model-providers/tool-orchestration.js';
import { isSideEffectTool, sideEffectReplayKey } from './side-effect-claims.js';

export interface StoredToolCall {
  name: string;
  input: unknown;
  result: unknown;
  duration_ms?: number;
  is_error?: boolean;
  result_status?: string;
  github_issue_receipt?: unknown;
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
    ...(execution.normalized_result && { result_status: execution.normalized_result.status }),
    ...(execution.github_issue_receipt && { github_issue_receipt: execution.github_issue_receipt }),
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
  requestedProvider?: ModelProviderId;
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
      requested_provider: input.requestedProvider ?? 'anthropic',
      requested_model: input.requestedModel,
      reason: 'stream_interrupted',
    },
    delivery_status: 'interrupted',
    ...(input.clientRequestId && { client_request_id: input.clientRequestId }),
  };
}

/**
 * Persist a mutation reservation before dispatch. If result persistence later
 * fails, this durable unknown-outcome record blocks an automatic replay.
 */
export function buildToolIntentCheckpoint(input: {
  threadId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  requestedModel: string;
  requestedProvider?: ModelProviderId;
  clientRequestId?: string;
}): CreateMessageInput {
  return {
    thread_id: input.threadId,
    role: 'assistant',
    content: '',
    tools_used: [input.toolName],
    tool_calls: [{
      name: input.toolName,
      input: input.parameters,
      result: 'External action dispatch reserved; outcome unknown.',
      is_error: true,
    }],
    model: input.requestedModel,
    model_execution: {
      source: 'local',
      requested_provider: input.requestedProvider ?? 'anthropic',
      requested_model: input.requestedModel,
      reason: 'stream_interrupted',
    },
    delivery_status: 'interrupted',
    ...(input.clientRequestId && { client_request_id: input.clientRequestId }),
  };
}

/**
 * The ThreadService checks an exact prior unknown-outcome intent under its
 * per-thread transaction lock, then writes this record before a handler may
 * be called. This also covers non-streaming delivery paths, which do not
 * otherwise reconstruct stream retry policy.
 */
export async function reserveToolIntentCheckpoint(
  threadService: Pick<ThreadService, 'addMessage'>,
  input: {
    threadId: string;
    toolName: string;
    parameters: Record<string, unknown>;
    requestedModel: string;
    requestedProvider?: ModelProviderId;
    clientRequestId?: string;
  },
): Promise<void> {
  await threadService.addMessage({
    ...buildToolIntentCheckpoint(input),
    mutation_reservation: { tool_name: input.toolName, input: input.parameters },
  });
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
      // Failed reads may be retried. A mutation with an error has an
      // ambiguous external outcome, so it is never automatically replayed.
      .filter((call) => call.is_error !== true || isSideEffectTool(call.name))
      .map((call) => isSideEffectTool(call.name)
        ? sideEffectReplayKey(call.name, call.input)
        : replayKey(call.name, call.input)),
  );
  if (completed.size === 0) return delegate;
  return async (request) => {
    const key = isSideEffectTool(request.toolName)
      ? sideEffectReplayKey(request.toolName, request.input)
      : replayKey(request.toolName, request.input);
    if (completed.has(key)) return { allowed: false };
    return delegate ? delegate(request) : { allowed: true };
  };
}
