import Anthropic from '@anthropic-ai/sdk';
import {
  UnexpectedModelIdentityError,
  type ModelFinishReason,
  type ModelProvider,
  type ModelProviderCapabilities,
  type ModelRequest,
  type ModelRespondOptions,
  type ModelResponse,
  type NormalizedModelEvent,
  type PreparedModelInvocation,
} from './model-provider.js';
import { validateModelCapabilities } from './capabilities.js';
import { validateNormalizedModelResponse } from './events.js';

type AnthropicRouterRequest = Record<string, unknown>;

interface AnthropicRouterResponseLike {
  id: string;
  model: string;
  content: unknown[];
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface AnthropicRouterMessagesTransport {
  messages: {
    create(
      request: AnthropicRouterRequest,
      options: { maxRetries: 0 | 2; signal?: AbortSignal },
    ): Promise<AnthropicRouterResponseLike>;
  };
}

export interface AnthropicRouterProviderOptions {
  /** Production passes 2 for parity; evaluation and shadow callers pass 0. */
  maxRetries: 0 | 2;
  transport?: AnthropicRouterMessagesTransport;
}

export const ANTHROPIC_ROUTER_CAPABILITIES: ModelProviderCapabilities = Object.freeze({
  streaming: false,
  structuredOutput: false,
  reasoning: false,
  reasoningEfforts: Object.freeze([] as const),
  customTools: false,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSafeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Malformed Anthropic router ${label}`);
  }
  return value as number;
}

function normalizeFinishReason(reason: string | null): ModelFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'refusal';
    case null:
      throw new Error('Anthropic router response completed without a stop reason');
    default:
      throw new Error('Unsupported Anthropic router stop reason');
  }
}

function normalizeRouterResponse(
  response: AnthropicRouterResponseLike,
  requestedModel: string,
): ModelResponse {
  if (typeof response.id !== 'string' || !response.id.trim() || response.id.length > 256) {
    throw new Error('Malformed Anthropic router response ID');
  }
  if (typeof response.model !== 'string' || !response.model.trim() || response.model.length > 256) {
    throw new Error('Malformed Anthropic router response model');
  }
  if (
    response.model !== requestedModel
    && !response.model.startsWith(`${requestedModel}-`)
  ) {
    throw new UnexpectedModelIdentityError('anthropic', requestedModel, response.model);
  }
  if (!Array.isArray(response.content) || response.content.length < 1) {
    throw new Error('Malformed Anthropic router response content');
  }

  const content = response.content.map((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('Anthropic router response must contain only text blocks');
    }
    return { type: 'text' as const, text: block.text };
  });
  if (!response.usage) throw new Error('Malformed Anthropic router response usage');
  const inputTokens = requireSafeCount(response.usage.input_tokens, 'input usage');
  const outputTokens = requireSafeCount(response.usage.output_tokens, 'output usage');
  const cacheWriteTokens = response.usage.cache_creation_input_tokens == null
    ? undefined
    : requireSafeCount(response.usage.cache_creation_input_tokens, 'cache write usage');
  const cacheReadTokens = response.usage.cache_read_input_tokens == null
    ? undefined
    : requireSafeCount(response.usage.cache_read_input_tokens, 'cache read usage');
  const providerFinishReason = response.stop_reason;
  const normalized = {
    provider: 'anthropic',
    model: response.model,
    id: response.id,
    content,
    finishReason: normalizeFinishReason(providerFinishReason),
    providerFinishReason: providerFinishReason!,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
      ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    },
  } satisfies ModelResponse;
  validateNormalizedModelResponse(normalized);
  return deepFreeze(normalized);
}

function requireRouterText(request: ModelRequest): string {
  if (request.system.length !== 0) {
    throw new Error('Anthropic router provider does not support system blocks');
  }
  if (
    request.messages.length !== 1
    || request.messages[0].role !== 'user'
    || request.messages[0].content.length !== 1
    || request.messages[0].content[0].type !== 'text'
  ) {
    throw new Error('Anthropic router provider requires exactly one user text message');
  }
  return request.messages[0].content[0].text;
}

/**
 * Tool-free adapter for Addie's historical Haiku router call. This deliberately
 * uses the stable Messages endpoint and its minimal request envelope; the
 * general Anthropic adapter uses a different signed beta envelope.
 */
export class AnthropicRouterProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = ANTHROPIC_ROUTER_CAPABILITIES;
  private readonly transport: AnthropicRouterMessagesTransport;
  private readonly maxRetries: 0 | 2;

  constructor(apiKey: string, options: AnthropicRouterProviderOptions) {
    if (options.maxRetries !== 0 && options.maxRetries !== 2) {
      throw new Error('Anthropic router maxRetries must be 0 or 2');
    }
    this.transport = options.transport
      ?? new Anthropic({ apiKey, maxRetries: 0 }) as unknown as AnthropicRouterMessagesTransport;
    this.maxRetries = options.maxRetries;
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    validateModelCapabilities('anthropic', this.capabilities, request);
    const text = requireRouterText(request);
    const providerRequest = deepFreeze(structuredClone({
      model: request.model,
      max_tokens: request.maxOutputTokens,
      messages: [{ role: 'user', content: text }],
    } satisfies AnthropicRouterRequest));
    const requestMetadata = request.requestMetadata === undefined
      ? undefined
      : deepFreeze(structuredClone(request.requestMetadata));
    return deepFreeze({
      provider: this.id,
      model: request.model,
      capabilities: this.capabilities,
      ...(requestMetadata !== undefined && { requestMetadata }),
      providerRequest,
    });
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    validateModelCapabilities(this.id, this.capabilities, request, { streaming: options.stream });
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    const response = await this.transport.messages.create(
      prepared.providerRequest,
      { maxRetries: this.maxRetries, ...(options.signal && { signal: options.signal }) },
    );
    const normalized = normalizeRouterResponse(response, request.model);
    yield {
      type: 'response_start',
      provider: this.id,
      model: normalized.model,
      id: normalized.id,
    };
    for (const [index, item] of normalized.content.entries()) {
      if (item.type !== 'text') {
        throw new Error('Anthropic router provider emitted non-text content');
      }
      yield { type: 'text_delta', index, text: item.text };
    }
    yield { type: 'response_complete', response: normalized };
  }
}
