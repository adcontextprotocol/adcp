import { isDeepStrictEqual } from 'node:util';
import type {
  ModelMessageContent,
  ModelProviderId,
  ModelResponse,
  NormalizedModelEvent,
} from './model-provider.js';

export class InvalidModelEventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelEventStreamError';
  }
}

function assertUsage(response: ModelResponse): void {
  for (const [name, value] of Object.entries(response.usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InvalidModelEventStreamError(`Invalid normalized usage field: ${name}`);
    }
  }
}

export interface ProviderToolCorrelationState {
  pending: Map<string, { provider: ModelProviderId; name: string }>;
}

export function createProviderToolCorrelationState(): ProviderToolCorrelationState {
  return { pending: new Map() };
}

export function validateNormalizedModelResponse(
  response: ModelResponse,
  correlationState?: ProviderToolCorrelationState,
): void {
  const stagedPending = correlationState
    ? new Map(correlationState.pending)
    : undefined;
  const providerCalls = new Map<string, { provider: ModelProviderId; name: string }>();
  const providerResultIds = new Set<string>();
  const clientCallIds = new Set<string>();
  let hasClientToolCall = false;
  let hasAnyToolCall = false;
  for (const content of response.content) {
    if (
      (content.type === 'provider_state'
        || content.type === 'provider_tool_call'
        || content.type === 'provider_tool_result')
      && content.provider !== response.provider
    ) {
      throw new InvalidModelEventStreamError('Nested provider content does not match terminal provider');
    }
    if (content.type === 'tool_call') {
      hasClientToolCall = true;
      hasAnyToolCall = true;
      if (clientCallIds.has(content.id)) {
        throw new InvalidModelEventStreamError('Duplicate client tool call ID');
      }
      clientCallIds.add(content.id);
    }
    if (content.type === 'provider_tool_call') {
      hasAnyToolCall = true;
      if (providerCalls.has(content.id) || stagedPending?.has(content.id)) {
        throw new InvalidModelEventStreamError('Duplicate provider tool call ID');
      }
      providerCalls.set(content.id, { provider: content.provider, name: content.name });
      stagedPending?.set(content.id, { provider: content.provider, name: content.name });
    }
  }
  for (const content of response.content) {
    if (content.type !== 'provider_tool_result') continue;
    if (providerResultIds.has(content.toolCallId)) {
      throw new InvalidModelEventStreamError('Duplicate provider tool result ID');
    }
    providerResultIds.add(content.toolCallId);
    const matchingCall = providerCalls.get(content.toolCallId)
      ?? stagedPending?.get(content.toolCallId);
    if (matchingCall) {
      if (matchingCall.provider !== content.provider || matchingCall.name !== content.name) {
        throw new InvalidModelEventStreamError('Provider tool result does not match its call');
      }
      stagedPending?.delete(content.toolCallId);
    } else if (stagedPending) {
      throw new InvalidModelEventStreamError('Provider tool result has no pending call');
    }
  }
  if (response.finishReason === 'tool_calls' && !hasAnyToolCall) {
    throw new InvalidModelEventStreamError('Tool-call finish has no tool call');
  }
  if (response.finishReason !== 'tool_calls' && hasClientToolCall) {
    throw new InvalidModelEventStreamError('Client tool call has incompatible finish reason');
  }
  assertUsage(response);
  if (correlationState && stagedPending) {
    correlationState.pending.clear();
    for (const [id, pending] of stagedPending) correlationState.pending.set(id, pending);
  }
}

/**
 * Collect a provider event stream without accepting partial or ambiguous
 * terminal state. Tool execution must only begin after this returns.
 */
export async function collectModelResponse(
  events: AsyncIterable<NormalizedModelEvent>,
  expectedProvider?: ModelProviderId,
  maxEvents = 10_000,
): Promise<ModelResponse> {
  let started = false;
  let terminal: ModelResponse | null = null;
  let eventCount = 0;
  let startProvider: ModelProviderId | null = null;
  let startModel: string | null = null;
  let startId: string | undefined;
  const emittedContent = new Map<number, ModelMessageContent>();
  const toolCallDeltas = new Map<number, { id?: string; name?: string; inputJson: string }>();

  const requireIndex = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new InvalidModelEventStreamError('Invalid normalized content index');
    }
  };

  for await (const event of events) {
    eventCount++;
    if (eventCount > maxEvents) {
      throw new InvalidModelEventStreamError('Normalized model event limit exceeded');
    }
    if (terminal) {
      throw new InvalidModelEventStreamError('Normalized model event received after terminal response');
    }
    if (event.type === 'response_start') {
      if (started) throw new InvalidModelEventStreamError('Duplicate normalized response_start');
      started = true;
      startProvider = event.provider;
      startModel = event.model;
      startId = event.id;
      if (expectedProvider && event.provider !== expectedProvider) {
        throw new InvalidModelEventStreamError('Normalized provider does not match selected provider');
      }
      continue;
    }
    if (!started) {
      throw new InvalidModelEventStreamError('Normalized event received before response_start');
    }
    if (event.type === 'text_delta') {
      requireIndex(event.index);
      const existing = emittedContent.get(event.index);
      if (existing && existing.type !== 'text') {
        throw new InvalidModelEventStreamError('Mixed normalized content types at one index');
      }
      emittedContent.set(event.index, {
        type: 'text',
        text: `${existing?.type === 'text' ? existing.text : ''}${event.text}`,
      });
    } else if (event.type === 'tool_call') {
      requireIndex(event.index);
      if (emittedContent.has(event.index)) {
        throw new InvalidModelEventStreamError('Duplicate normalized content index');
      }
      const deltas = toolCallDeltas.get(event.index);
      if (deltas?.id !== undefined && deltas.id !== event.call.id) {
        throw new InvalidModelEventStreamError('Tool call delta ID does not match completed call');
      }
      if (deltas?.name !== undefined && deltas.name !== event.call.name) {
        throw new InvalidModelEventStreamError('Tool call delta name does not match completed call');
      }
      if (deltas?.inputJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(deltas.inputJson);
        } catch {
          throw new InvalidModelEventStreamError('Tool call delta arguments are not valid JSON');
        }
        if (!isDeepStrictEqual(parsed, event.call.input)) {
          throw new InvalidModelEventStreamError('Tool call delta arguments do not match completed call');
        }
      }
      emittedContent.set(event.index, event.call);
    } else if (event.type === 'provider_state') {
      requireIndex(event.index);
      if (emittedContent.has(event.index)) {
        throw new InvalidModelEventStreamError('Duplicate normalized content index');
      }
      emittedContent.set(event.index, event.state);
    } else if (event.type === 'provider_tool_call') {
      requireIndex(event.index);
      if (emittedContent.has(event.index)) {
        throw new InvalidModelEventStreamError('Duplicate normalized content index');
      }
      emittedContent.set(event.index, event.call);
    } else if (event.type === 'provider_tool_result') {
      requireIndex(event.index);
      if (emittedContent.has(event.index)) {
        throw new InvalidModelEventStreamError('Duplicate normalized content index');
      }
      emittedContent.set(event.index, event.result);
    } else if (event.type === 'tool_call_delta') {
      requireIndex(event.index);
      if (emittedContent.has(event.index)) {
        throw new InvalidModelEventStreamError('Tool call delta received after completed call');
      }
      const previous = toolCallDeltas.get(event.index) ?? { inputJson: '' };
      if (event.id !== undefined && previous.id !== undefined && event.id !== previous.id) {
        throw new InvalidModelEventStreamError('Tool call delta ID changed');
      }
      if (event.name !== undefined && previous.name !== undefined && event.name !== previous.name) {
        throw new InvalidModelEventStreamError('Tool call delta name changed');
      }
      const inputJson = `${previous.inputJson}${event.inputJsonDelta ?? ''}`;
      if (Buffer.byteLength(inputJson, 'utf8') > 1024 * 1024) {
        throw new InvalidModelEventStreamError('Tool call delta arguments exceed size limit');
      }
      toolCallDeltas.set(event.index, {
        id: event.id ?? previous.id,
        name: event.name ?? previous.name,
        inputJson,
      });
    } else if (event.type === 'response_complete') {
      terminal = event.response;
    }
  }

  if (!started) throw new InvalidModelEventStreamError('Missing normalized response_start');
  if (!terminal) throw new InvalidModelEventStreamError('Missing normalized response_complete');
  if (terminal.provider !== startProvider || terminal.model !== startModel) {
    throw new InvalidModelEventStreamError('Normalized terminal identity changed during response');
  }
  if (startId !== undefined && terminal.id !== startId) {
    throw new InvalidModelEventStreamError('Normalized terminal response ID changed');
  }
  if (terminal.content.length !== emittedContent.size) {
    throw new InvalidModelEventStreamError('Normalized events do not match terminal content');
  }
  for (const index of toolCallDeltas.keys()) {
    if (emittedContent.get(index)?.type !== 'tool_call') {
      throw new InvalidModelEventStreamError('Tool call deltas missing a completed tool call');
    }
  }
  for (let index = 0; index < terminal.content.length; index++) {
    if (!isDeepStrictEqual(emittedContent.get(index), terminal.content[index])) {
      throw new InvalidModelEventStreamError('Normalized events do not match terminal content');
    }
  }
  validateNormalizedModelResponse(terminal);
  return terminal;
}
