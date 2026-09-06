import OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import type {
  JsonObject,
  ModelFinishReason,
  ModelMessage,
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
import { assertPlainJson, validateModelCapabilities } from './capabilities.js';
import { validateNormalizedModelResponse } from './events.js';

export const OPENAI_ROUTER_MODEL = 'gpt-5.6-luna';

/**
 * The Responses adapter has no reviewed alias allowlist. Keep this exported
 * predicate as the shared, typed billing-identity boundary for consumers that
 * must prove a returned response has the requested model's exact price.
 */
export function openaiReturnedModelIdentityMatches(requestedModel: string, returnedModel: string): boolean {
  return requestedModel === returnedModel;
}

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
  customTools: true,
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

function toOpenAITool(tool: ModelRequest['tools'][number]): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.inputSchema) as Record<string, unknown>,
    // Addie's canonical schemas intentionally allow optional properties that
    // do not satisfy OpenAI's strict-schema subset. Runtime validation and the
    // common tool executor remain authoritative.
    strict: false,
  };
}

function parseToolInput(value: string, name: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Malformed OpenAI function arguments for ${name}`);
  }
  assertPlainJson(parsed, `OpenAI function arguments for ${name}`);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed OpenAI function arguments for ${name}`);
  }
  return parsed as JsonObject;
}

function toolResultOutput(content: Extract<ModelMessageContent, { type: 'tool_result' }>): string {
  const output = typeof content.content === 'string'
    ? content.content
    : textOnly(content.content, `tool result ${content.toolCallId}`);
  return content.isError
    ? `[Tool execution error]\n${output || 'No error details provided.'}`
    : output;
}

function toOpenAIInput(messages: readonly ModelMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.content.length === 0) throw new Error('OpenAI adapter requires non-empty messages');
    let pendingText: string[] = [];
    const flushText = () => {
      if (pendingText.length === 0) return;
      input.push({ type: 'message', role: message.role, content: pendingText.join('') });
      pendingText = [];
    };
    for (const content of message.content) {
      if (content.type === 'text') {
        pendingText.push(content.text);
        continue;
      }
      flushText();
      if (content.type === 'tool_call' && message.role === 'assistant') {
        input.push({
          type: 'function_call',
          call_id: content.id,
          name: content.name,
          arguments: JSON.stringify(content.input),
        });
      } else if (content.type === 'tool_result' && message.role === 'user') {
        input.push({
          type: 'function_call_output',
          call_id: content.toolCallId,
          output: toolResultOutput(content),
        });
      } else {
        throw new Error(`OpenAI adapter does not support ${content.type} in a ${message.role} message`);
      }
    }
    flushText();
  }
  return input;
}

function toOpenAIRequest(request: ModelRequest): ResponseCreateParamsNonStreaming {
  validateModelCapabilities('openai', OPENAI_RESPONSES_CAPABILITIES, request);
  if (request.model !== OPENAI_ROUTER_MODEL) {
    throw new Error(`Unsupported OpenAI router model: ${request.model}`);
  }
  if (request.system.some((block) => block.cacheHint !== undefined)) {
    throw new Error('OpenAI router adapter does not support cache hints');
  }
  if ((request.providerTools?.length ?? 0) > 0) {
    throw new Error('OpenAI adapter does not support provider tools');
  }

  const effort = request.reasoning?.effort;
  return {
    model: request.model,
    instructions: request.system.map((block) => block.text).join('\n\n'),
    input: toOpenAIInput(request.messages),
    max_output_tokens: request.maxOutputTokens,
    store: false,
    background: false,
    stream: false,
    truncation: 'disabled',
    parallel_tool_calls: false,
    tools: request.tools.map(toOpenAITool),
    ...(request.toolChoice && {
      tool_choice: request.toolChoice.type === 'tool'
        ? { type: 'function' as const, name: request.toolChoice.name }
        : request.toolChoice.type,
    }),
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
    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string'
        || !item.call_id.trim()
        || item.call_id.length > 256
        || typeof item.name !== 'string'
        || !item.name.trim()
        || item.name.length > 128
        || typeof item.arguments !== 'string'
        || Buffer.byteLength(item.arguments, 'utf8') > 1024 * 1024
        || (item.status !== undefined && item.status !== 'completed')
        || item.namespace !== undefined
        || (item.caller !== undefined && item.caller !== null && item.caller.type !== 'direct')
      ) throw new Error('Malformed OpenAI function call');
      content.push({
        type: 'tool_call',
        id: item.call_id,
        name: item.name,
        input: parseToolInput(item.arguments, item.name),
      });
    } else if (item.type === 'message' && item.role === 'assistant') {
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
    } else throw new Error(`Unexpected OpenAI output item: ${item.type}`);
  }

  const hasFunctionCall = content.some((item) => item.type === 'tool_call');
  if (hasFunctionCall && finishReason !== 'stop') {
    throw new Error('OpenAI response ended before function calls were terminal');
  }
  if (refused) finishReason = 'refusal';
  else if (hasFunctionCall) finishReason = 'tool_calls';

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
      ...(response.usage.input_tokens_details.cached_tokens !== undefined && {
        cacheReadTokens: response.usage.input_tokens_details.cached_tokens,
      }),
      ...(response.usage.input_tokens_details.cache_write_tokens !== undefined && {
        cacheWriteTokens: response.usage.input_tokens_details.cache_write_tokens,
      }),
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
    validateModelCapabilities(this.id, this.capabilities, request, { streaming: options.stream });
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    const response = await this.transport.responses.create(
      prepared.providerRequest as ResponseCreateParamsNonStreaming,
      { maxRetries: 0, signal: options.signal },
    );
    const normalized = normalizeOpenAIResponse(response);
    // Returned model identity is a billing and trust boundary. This adapter has
    // no reviewed, literal canonical-alias allowlist, so aliases and suffixes
    // must not inherit the requested model's approval or pricing.
    if (!openaiReturnedModelIdentityMatches(request.model, normalized.model)) {
      throw new UnexpectedModelIdentityError('openai', request.model, normalized.model);
    }
    yield { type: 'response_start', provider: this.id, model: normalized.model, id: normalized.id };
    for (const [index, item] of normalized.content.entries()) {
      if (item.type === 'text') yield { type: 'text_delta', index, text: item.text };
      else if (item.type === 'tool_call') yield { type: 'tool_call', index, call: item };
      else throw new Error('OpenAI adapter emitted unsupported content');
    }
    yield { type: 'response_complete', response: normalized };
  }
}
