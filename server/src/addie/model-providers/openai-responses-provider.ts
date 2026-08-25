import OpenAI from 'openai';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import type {
  ModelFinishReason,
  ModelMessageContent,
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from './model-provider.js';
import { UnexpectedModelIdentityError } from './model-provider.js';
import { validateModelCapabilities } from './capabilities.js';
import { validateNormalizedModelResponse } from './events.js';

export const OPENAI_ROUTER_MODEL = 'gpt-5.6-luna';

export interface OpenAIResponsesTransport {
  responses: {
    create(
      request: ResponseCreateParamsNonStreaming,
      options: { maxRetries: 0; signal?: AbortSignal },
    ): Promise<Response>;
  };
}

export const OPENAI_RESPONSES_CAPABILITIES: ModelProviderCapabilities = Object.freeze({
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  reasoningEfforts: Object.freeze(['provider_default', 'none', 'low', 'medium', 'high'] as const),
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

function assertSafeCount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Malformed OpenAI ${label}`);
  }
}

function textOnly(content: ModelMessageContent[], label: string): string {
  if (content.length < 1 || content.some((block) => block.type !== 'text')) {
    throw new Error(`OpenAI router adapter requires text-only ${label}`);
  }
  return content.map((block) => block.type === 'text' ? block.text : '').join('');
}

function toOpenAIRequest(request: ModelRequest): ResponseCreateParamsNonStreaming {
  validateModelCapabilities('openai', OPENAI_RESPONSES_CAPABILITIES, request);
  if (request.model !== OPENAI_ROUTER_MODEL) {
    throw new Error(`Unsupported OpenAI router model: ${request.model}`);
  }
  if (request.system.some((block) => block.cacheHint !== undefined)) {
    throw new Error('OpenAI router adapter does not support cache hints');
  }
  if (request.tools.length > 0 || (request.providerTools?.length ?? 0) > 0) {
    throw new Error('OpenAI router adapter is tool-free');
  }

  const effort = request.reasoning?.effort;
  return {
    model: request.model,
    instructions: request.system.map((block) => block.text).join('\n\n'),
    input: request.messages.map((message) => ({
      type: 'message' as const,
      role: message.role,
      content: textOnly(message.content, 'messages'),
    })),
    max_output_tokens: request.maxOutputTokens,
    store: false,
    background: false,
    stream: false,
    truncation: 'disabled',
    parallel_tool_calls: false,
    tools: [],
    text: request.outputSchema
      ? {
          format: {
            type: 'json_schema',
            name: request.outputSchema.name,
            ...(request.outputSchema.description && { description: request.outputSchema.description }),
            schema: request.outputSchema.schema,
            strict: request.outputSchema.strict ?? true,
          },
        }
      : { format: { type: 'text' } },
    ...(effort && effort !== 'provider_default'
      ? { reasoning: { effort } }
      : {}),
  };
}

export function normalizeOpenAIResponse(response: Response): ModelResponse {
  if (typeof response.id !== 'string' || !response.id.trim() || response.id.length > 256) {
    throw new Error('Malformed OpenAI response ID');
  }
  if (typeof response.model !== 'string' || !response.model.trim() || response.model.length > 256) {
    throw new Error('Malformed OpenAI response model');
  }
  if (!response.usage) throw new Error('Malformed OpenAI response usage');
  assertSafeCount(response.usage.input_tokens, 'input usage');
  assertSafeCount(response.usage.output_tokens, 'output usage');
  if (!Array.isArray(response.output)) throw new Error('Malformed OpenAI response output');

  let finishReason: ModelFinishReason;
  if (response.status === 'completed') finishReason = 'stop';
  else if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length';
  else if (response.status === 'incomplete' && response.incomplete_details?.reason === 'content_filter') finishReason = 'refusal';
  else throw new Error(`Nonterminal OpenAI response status: ${response.status}`);

  const content: ModelMessageContent[] = [];
  let refused = finishReason === 'refusal';
  for (const item of response.output) {
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant') {
      throw new Error(`Unexpected OpenAI output item: ${item.type}`);
    }
    if (item.status !== 'completed' && response.status === 'completed') {
      throw new Error('Incomplete OpenAI message output');
    }
    for (const part of item.content) {
      if (part.type === 'output_text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'refusal') {
        refused = true;
      } else {
        const exhaustive: never = part;
        throw new Error(`Unexpected OpenAI message part: ${String(exhaustive)}`);
      }
    }
  }

  if (refused) finishReason = 'refusal';

  if (finishReason === 'stop' && content.length < 1) throw new Error('Empty OpenAI response output');
  const normalized = deepFreeze({
    provider: 'openai',
    model: response.model,
    id: response.id,
    content,
    finishReason,
    providerFinishReason: response.status,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.input_tokens_details.cached_tokens,
      cacheWriteTokens: response.usage.input_tokens_details.cache_write_tokens,
    },
  } satisfies ModelResponse);
  validateNormalizedModelResponse(normalized);
  return normalized;
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly id = 'openai' as const;
  readonly capabilities = OPENAI_RESPONSES_CAPABILITIES;
  private readonly transport: OpenAIResponsesTransport;

  constructor(apiKey: string, transport?: OpenAIResponsesTransport) {
    this.transport = transport ?? new OpenAI({ apiKey, maxRetries: 0 });
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    const providerRequest = (
      deepFreeze(structuredClone(toOpenAIRequest(request)))
    ) as unknown as Readonly<Record<string, unknown>>;
    return deepFreeze({
      provider: this.id,
      model: request.model,
      capabilities: this.capabilities,
      requestMetadata: request.requestMetadata,
      providerRequest,
    });
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    const response = await this.transport.responses.create(
      prepared.providerRequest as ResponseCreateParamsNonStreaming,
      { maxRetries: 0, signal: options.signal },
    );
    const normalized = normalizeOpenAIResponse(response);
    if (normalized.model !== request.model && !normalized.model.startsWith(`${request.model}-`)) {
      throw new UnexpectedModelIdentityError('openai', request.model, normalized.model);
    }
    yield { type: 'response_start', provider: this.id, model: normalized.model, id: normalized.id };
    for (const [index, item] of normalized.content.entries()) {
      if (item.type !== 'text') throw new Error('OpenAI router adapter emitted non-text content');
      yield { type: 'text_delta', index, text: item.text };
    }
    yield { type: 'response_complete', response: normalized };
  }
}
