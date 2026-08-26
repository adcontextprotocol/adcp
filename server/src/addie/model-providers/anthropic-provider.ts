import Anthropic from '@anthropic-ai/sdk';
import {
  UnsupportedModelCapabilityError,
  type ModelFinishReason,
  type ModelMessageContent,
  type ModelProvider,
  type ModelProviderCapabilities,
  type ModelProviderStateContent,
  type ModelProviderToolCallContent,
  type ModelProviderToolReceipt,
  type ModelProviderToolResultContent,
  type ModelRequest,
  type ModelRespondOptions,
  type ModelResponse,
  type ModelToolDefinition,
  type NormalizedModelEvent,
  type PreparedModelInvocation,
} from './model-provider.js';
import { assertPlainJson, validateModelCapabilities } from './capabilities.js';
import { validateNormalizedModelResponse } from './events.js';

type AnthropicRequest = Record<string, unknown>;

interface AnthropicResponseLike {
  id: string;
  model: string;
  content: unknown[];
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AnthropicMessagesTransport {
  beta: {
    messages: {
      create(
        request: AnthropicRequest,
        options: { maxRetries: 0; signal?: AbortSignal },
      ): Promise<AnthropicResponseLike>;
    };
  };
}

export const ANTHROPIC_PROVIDER_CAPABILITIES: ModelProviderCapabilities = Object.freeze({
  streaming: false,
  structuredOutput: false,
  reasoning: true,
  reasoningEfforts: Object.freeze(['provider_default'] as const),
  customTools: true,
  providerWebSearch: true,
  imageInput: true,
  documentInput: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Malformed Anthropic ${label}`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const MAX_CONTINUATION_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BLOCKS = 1_000;
const ANTHROPIC_WEB_SEARCH_ERROR_CODES = new Set([
  'invalid_tool_input',
  'unavailable',
  'max_uses_exceeded',
  'too_many_requests',
  'query_too_long',
  'request_too_large',
]);
const ANTHROPIC_WEB_SEARCH_INPUT_KEYS = new Set(['query']);
const anthropicContinuationPayloads = new WeakMap<object, Readonly<Record<string, unknown>>>();

function rememberAnthropicContinuation<T extends object>(
  content: T,
  payload: Readonly<Record<string, unknown>>,
): T {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTINUATION_BYTES) {
    throw new Error('Anthropic continuation state exceeds size limit');
  }
  const frozenContent = deepFreeze(content);
  anthropicContinuationPayloads.set(frozenContent, deepFreeze(structuredClone(payload)));
  return frozenContent;
}

function requireAnthropicContinuation(content: object): Readonly<Record<string, unknown>> {
  const payload = anthropicContinuationPayloads.get(content);
  if (!payload) throw new Error('Anthropic continuation state was not issued by this adapter');
  return payload;
}

function toAnthropicContent(content: ModelMessageContent): Record<string, unknown> {
  const issuedContinuation = anthropicContinuationPayloads.get(content);
  if (issuedContinuation) return { ...issuedContinuation };
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: content.mediaType, data: content.data },
      };
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: content.mediaType, data: content.data },
      };
    case 'tool_call':
      return { type: 'tool_use', id: content.id, name: content.name, input: content.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: content.toolCallId,
        content: typeof content.content === 'string'
          ? content.content
          : content.content.map(toAnthropicContent),
        ...(content.isError !== undefined && { is_error: content.isError }),
      };
    case 'provider_tool_call':
    case 'provider_tool_result':
    case 'provider_state':
      if (content.provider !== 'anthropic') {
        throw new Error(`Cannot send ${content.provider} continuation state to Anthropic`);
      }
      return { ...requireAnthropicContinuation(content) };
    default: {
      const exhaustive: never = content;
      throw new Error(`Unsupported canonical content: ${String(exhaustive)}`);
    }
  }
}

function toAnthropicMessages(messages: ModelRequest['messages']): Array<Record<string, unknown>> {
  const translated = messages.map((message) => {
    const blocks = message.content.map(toAnthropicContent);
    const content = blocks.length === 1 && blocks[0].type === 'text'
      ? blocks[0].text
      : blocks;
    return { role: message.role, content };
  });

  const merged: Array<Record<string, unknown>> = [];
  for (const message of translated) {
    const previous = merged[merged.length - 1];
    if (previous?.role === message.role) {
      const previousContent = Array.isArray(previous.content)
        ? previous.content
        : [{ type: 'text', text: previous.content }];
      const nextContent = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: message.content }];
      previous.content = [...previousContent, ...nextContent];
    } else {
      merged.push({ ...message });
    }
  }
  return merged;
}

function toAnthropicTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(tool.cacheHint === 'ephemeral' && { cache_control: { type: 'ephemeral' } }),
  };
}

function normalizeFinishReason(reason: string | null): ModelFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
    case 'compaction':
      return 'continue';
    case null:
      throw new Error('Anthropic response completed without a stop reason');
    default:
      throw new Error(`Unhandled Anthropic stop reason: ${reason}`);
  }
}

function normalizeAnthropicContent(block: unknown): ModelMessageContent {
  const record = requireRecord(block, 'content block');
  switch (record.type) {
    case 'text':
      if (typeof record.text !== 'string') throw new Error('Malformed Anthropic text block');
      return rememberAnthropicContinuation({ type: 'text', text: record.text }, record);
    case 'tool_use':
      if (
        typeof record.id !== 'string'
        || typeof record.name !== 'string'
        || !isRecord(record.input)
      ) {
        throw new Error('Malformed Anthropic tool_use block');
      }
      assertPlainJson(record.input, 'Anthropic tool input');
      return rememberAnthropicContinuation({
        type: 'tool_call', id: record.id, name: record.name, input: record.input,
      }, record);
    case 'server_tool_use': {
      if (
        typeof record.id !== 'string'
        || record.name !== 'web_search'
        || !isRecord(record.input)
      ) throw new Error('Malformed Anthropic server_tool_use block');
      return rememberAnthropicContinuation({
        type: 'provider_tool_call',
        provider: 'anthropic',
        id: record.id,
        name: 'web_search',
        inputKeys: Object.keys(record.input)
          .filter((key) => ANTHROPIC_WEB_SEARCH_INPUT_KEYS.has(key))
          .sort(),
      } as const, record);
    }
    case 'web_search_tool_result': {
      if (
        typeof record.tool_use_id !== 'string'
        || (!Array.isArray(record.content) && !isRecord(record.content))
      ) throw new Error('Malformed Anthropic web_search_tool_result block');
      const errorContent = isRecord(record.content) ? record.content : null;
      const isError = errorContent !== null;
      if (
        isError
        && (
          errorContent.type !== 'web_search_tool_result_error'
          || typeof errorContent.error_code !== 'string'
          || !ANTHROPIC_WEB_SEARCH_ERROR_CODES.has(errorContent.error_code)
        )
      ) throw new Error('Malformed Anthropic web_search_tool_result block');
      if (
        Array.isArray(record.content)
        && record.content.some((item) => !isRecord(item) || item.type !== 'web_search_result')
      ) throw new Error('Malformed Anthropic web_search_tool_result block');
      const errorCode = errorContent && typeof errorContent.error_code === 'string'
        ? errorContent.error_code
        : undefined;
      return rememberAnthropicContinuation({
        type: 'provider_tool_result',
        provider: 'anthropic',
        toolCallId: record.tool_use_id,
        name: 'web_search',
        resultCount: Array.isArray(record.content) ? record.content.length : 0,
        isError,
        ...(errorCode && { errorCode }),
      } as const, record);
    }
    case 'thinking':
      if (typeof record.thinking !== 'string' || typeof record.signature !== 'string') {
        throw new Error('Malformed Anthropic thinking block');
      }
      return rememberAnthropicContinuation({
        type: 'provider_state',
        provider: 'anthropic',
        kind: String(record.type),
      } as const, record);
    case 'redacted_thinking':
      if (typeof record.data !== 'string') throw new Error('Malformed Anthropic redacted_thinking block');
      return rememberAnthropicContinuation({
        type: 'provider_state', provider: 'anthropic', kind: 'redacted_thinking',
      } as const, record);
    case 'compaction':
      if (
        !(typeof record.content === 'string' || record.content === null)
        || !(typeof record.encrypted_content === 'string' || record.encrypted_content === null)
      ) throw new Error('Malformed Anthropic compaction block');
      return rememberAnthropicContinuation({
        type: 'provider_state', provider: 'anthropic', kind: 'compaction',
      } as const, record);
    default:
      throw new Error(`Unhandled Anthropic content block: ${String(record.type)}`);
  }
}

export function normalizeAnthropicResponse(response: AnthropicResponseLike): ModelResponse {
  if (typeof response.id !== 'string' || !response.id.trim() || response.id.length > 256) {
    throw new Error('Malformed Anthropic response ID');
  }
  if (typeof response.model !== 'string' || !response.model.trim() || response.model.length > 256) {
    throw new Error('Malformed Anthropic response model');
  }
  if (!Array.isArray(response.content)) throw new Error('Malformed Anthropic response content');
  if (response.content.length > MAX_RESPONSE_BLOCKS) {
    throw new Error('Anthropic response content block limit exceeded');
  }
  if (
    !response.usage
    || !Number.isSafeInteger(response.usage.input_tokens)
    || (response.usage.input_tokens ?? -1) < 0
    || !Number.isSafeInteger(response.usage.output_tokens)
    || (response.usage.output_tokens ?? -1) < 0
  ) {
    throw new Error('Malformed Anthropic response usage');
  }
  for (const optionalUsage of [
    response.usage.cache_creation_input_tokens,
    response.usage.cache_read_input_tokens,
  ]) {
    if (optionalUsage !== undefined && (!Number.isSafeInteger(optionalUsage) || optionalUsage < 0)) {
      throw new Error('Malformed Anthropic response usage');
    }
  }
  const providerFinishReason = response.stop_reason;
  if (providerFinishReason === null) {
    throw new Error('Anthropic response completed without a stop reason');
  }
  const normalizedContent = response.content.map(normalizeAnthropicContent);
  const normalized = {
    provider: 'anthropic',
    model: response.model,
    id: response.id,
    content: normalizedContent,
    finishReason: normalizeFinishReason(providerFinishReason),
    providerFinishReason,
    usage: {
      inputTokens: response.usage.input_tokens!,
      outputTokens: response.usage.output_tokens!,
      ...(response.usage?.cache_creation_input_tokens !== undefined && {
        cacheWriteTokens: response.usage.cache_creation_input_tokens,
      }),
      ...(response.usage?.cache_read_input_tokens !== undefined && {
        cacheReadTokens: response.usage.cache_read_input_tokens,
      }),
    },
  } satisfies ModelResponse;
  validateNormalizedModelResponse(normalized);
  return deepFreeze(normalized);
}

export function deriveAnthropicProviderToolReceipt(
  call: ModelProviderToolCallContent,
  result: ModelProviderToolResultContent,
  disclosure: 'production' | 'redacted',
): ModelProviderToolReceipt {
  if (
    call.provider !== 'anthropic'
    || result.provider !== 'anthropic'
    || call.name !== 'web_search'
    || result.name !== 'web_search'
    || call.id !== result.toolCallId
  ) throw new Error('Anthropic provider tool receipt does not match');
  const rawCall = requireAnthropicContinuation(call);
  const rawResult = requireAnthropicContinuation(result);
  if (disclosure === 'redacted') {
    return {
      toolCallId: call.id,
      toolName: 'web_search',
      parameters: {},
      resultSummary: result.isError ? 'Web search failed' : `Web search completed (${result.resultCount} results)`,
      resultDetails: result.isError ? 'Web search failed' : `Web search completed (${result.resultCount} results)`,
      isError: result.isError,
    };
  }

  const rawInput = isRecord(rawCall.input) ? rawCall.input : {};
  const query = typeof rawInput.query === 'string' ? rawInput.query : undefined;
  const resultSummary = result.isError
    ? `Web search failed: ${result.errorCode ?? 'unknown'}`
    : `Web search completed (${result.resultCount} results)`;
  const rawResults = Array.isArray(rawResult.content) ? rawResult.content : [];
  const resultLines = rawResults.slice(0, 5).map((item) => {
    if (!isRecord(item)) return '';
    const title = typeof item.title === 'string' ? item.title.slice(0, 1_000) : '';
    const url = typeof item.url === 'string' ? item.url.slice(0, 2_000) : '';
    return title ? `${title}: ${url}` : url;
  }).filter(Boolean);
  return {
    toolCallId: call.id,
    toolName: 'web_search',
    parameters: query === undefined ? {} : { query },
    resultSummary,
    resultDetails: resultLines.length > 0
      ? `${resultSummary}\n\nTop results:\n${resultLines.join('\n')}`
      : resultSummary,
    isError: result.isError,
  };
}

export class AnthropicModelProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = ANTHROPIC_PROVIDER_CAPABILITIES;
  private readonly transport: AnthropicMessagesTransport;

  constructor(apiKey: string, transport?: AnthropicMessagesTransport) {
    this.transport = transport ?? new Anthropic({ apiKey }) as unknown as AnthropicMessagesTransport;
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    validateModelCapabilities('anthropic', this.capabilities, request);
    if (request.outputSchema) {
      throw new UnsupportedModelCapabilityError('anthropic', 'structuredOutput');
    }
    const tools: Record<string, unknown>[] = request.tools.map(toAnthropicTool);
    for (const providerTool of request.providerTools ?? []) {
      if (providerTool.type !== 'web_search') {
        throw new Error('Unsupported Anthropic provider tool');
      }
      tools.push({ type: 'web_search_20250305', name: 'web_search' });
    }

    const providerRequest = deepFreeze(structuredClone({
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: request.system.map((block) => ({
        type: 'text',
        text: block.text,
        ...(block.cacheHint === 'ephemeral' && { cache_control: { type: 'ephemeral' } }),
      })),
      tools,
      messages: toAnthropicMessages(request.messages),
      betas: ['web-search-2025-03-05'],
    } satisfies AnthropicRequest));

    return {
      provider: 'anthropic',
      model: request.model,
      capabilities: this.capabilities,
      requestMetadata: request.requestMetadata,
      providerRequest,
    };
  }

  deriveProviderToolReceipt(
    call: ModelProviderToolCallContent,
    result: ModelProviderToolResultContent,
    disclosure: 'production' | 'redacted',
  ): ModelProviderToolReceipt {
    return deriveAnthropicProviderToolReceipt(call, result, disclosure);
  }

  async *respond(
    request: ModelRequest,
    options?: ModelRespondOptions,
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options?.beforeDispatch?.(prepared);
    const response = await this.transport.beta.messages.create(
      prepared.providerRequest as AnthropicRequest,
      { maxRetries: 0, ...(options?.signal && { signal: options.signal }) },
    );
    const normalized = normalizeAnthropicResponse(response);
    yield {
      type: 'response_start',
      provider: 'anthropic',
      model: normalized.model,
      id: normalized.id,
    };
    for (let index = 0; index < normalized.content.length; index++) {
      const content = normalized.content[index];
      if (content.type === 'text') {
        yield { type: 'text_delta', index, text: content.text };
      } else if (content.type === 'tool_call') {
        yield { type: 'tool_call', index, call: content };
      } else if (content.type === 'provider_tool_call') {
        yield { type: 'provider_tool_call', index, call: content };
      } else if (content.type === 'provider_tool_result') {
        yield { type: 'provider_tool_result', index, result: content };
      } else if (content.type === 'provider_state') {
        yield { type: 'provider_state', index, state: content as ModelProviderStateContent };
      }
    }
    yield { type: 'response_complete', response: normalized };
  }
}
