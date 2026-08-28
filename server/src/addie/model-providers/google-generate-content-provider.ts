import {
  BlockedReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
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
import { assertPlainJson, validateModelCapabilities } from './capabilities.js';
import { validateNormalizedModelResponse } from './events.js';

export const GOOGLE_ROUTER_MODEL = 'gemini-3.7-flash';

export interface GoogleGenerateContentTransport {
  models: {
    generateContent(
      request: GenerateContentParameters,
      options?: { signal?: AbortSignal },
    ): Promise<GenerateContentResponse>;
  };
}

export const GOOGLE_GENERATE_CONTENT_CAPABILITIES: ModelProviderCapabilities = Object.freeze({
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  reasoningEfforts: Object.freeze(['provider_default', 'low', 'medium', 'high'] as const),
  customTools: true,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
});

const MAX_GOOGLE_RESPONSE_PARTS = 1_000;
const MAX_GOOGLE_CONTINUATION_BYTES = 2 * 1024 * 1024;
const googleContinuationParts = new WeakMap<object, Readonly<Part>>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertSafeCount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Malformed Google ${label}`);
  }
}

function textOnly(content: ModelMessageContent[], label: string): string {
  if (content.length < 1 || content.some((block) => block.type !== 'text')) {
    throw new Error(`Google router adapter requires text-only ${label}`);
  }
  return content.map((block) => block.type === 'text' ? block.text : '').join('');
}

function rememberGoogleContinuation<T extends object>(content: T, part: Part): T {
  const serialized = JSON.stringify(part);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_GOOGLE_CONTINUATION_BYTES) {
    throw new Error('Google continuation state exceeds size limit');
  }
  const frozen = deepFreeze(content);
  googleContinuationParts.set(frozen, deepFreeze(structuredClone(part)));
  return frozen;
}

function toGooglePart(content: ModelMessageContent): Part {
  const continuation = googleContinuationParts.get(content);
  if (continuation) return { ...continuation };
  switch (content.type) {
    case 'text':
      return { text: content.text };
    case 'tool_call':
      throw new Error('Google tool-call continuation was not issued by this adapter');
    case 'tool_result': {
      if (typeof content.content !== 'string') {
        throw new Error('Google tool results must be text-only');
      }
      if (!content.toolName?.trim()) {
        throw new Error('Google tool results require the tool name');
      }
      return {
        functionResponse: {
          id: content.toolCallId,
          name: content.toolName,
          response: content.isError
            ? { error: content.content }
            : { output: content.content },
        },
      };
    }
    case 'provider_state':
    case 'provider_tool_call':
    case 'provider_tool_result':
      throw new Error(`Cannot send ${content.provider} continuation state to Google`);
    case 'image':
    case 'document':
      throw new Error('Google adapter does not support media input');
    default: {
      const exhaustive: never = content;
      throw new Error(`Unsupported canonical content: ${String(exhaustive)}`);
    }
  }
}

function toGoogleContents(messages: ModelRequest['messages']): GenerateContentParameters['contents'] {
  const pendingCalls = new Map<string, string>();
  const translated = messages.map((message) => {
    for (const content of message.content) {
      if (content.type === 'tool_call') {
        if (message.role !== 'assistant' || pendingCalls.has(content.id)) {
          throw new Error('Malformed Google tool-call continuation');
        }
        pendingCalls.set(content.id, content.name);
      } else if (content.type === 'tool_result') {
        const expectedName = pendingCalls.get(content.toolCallId);
        if (
          message.role !== 'user'
          || expectedName === undefined
          || content.toolName !== expectedName
        ) throw new Error('Google tool result does not match its call');
        pendingCalls.delete(content.toolCallId);
      }
    }
    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: message.content.map(toGooglePart),
    };
  });
  if (pendingCalls.size > 0) {
    throw new Error('Google tool-call continuation is missing a result');
  }
  const merged: typeof translated = [];
  for (const message of translated) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) previous.parts.push(...message.parts);
    else merged.push({ role: message.role, parts: [...message.parts] });
  }
  return merged;
}

function toGoogleRequest(request: ModelRequest): GenerateContentParameters {
  validateModelCapabilities('google', GOOGLE_GENERATE_CONTENT_CAPABILITIES, request);
  if (request.model !== GOOGLE_ROUTER_MODEL) {
    throw new Error(`Unsupported Google router model: ${request.model}`);
  }
  if (request.system.some((block) => block.cacheHint !== undefined)) {
    throw new Error('Google router adapter does not support cache hints');
  }
  if ((request.providerTools?.length ?? 0) > 0) {
    throw new Error('Google adapter does not support provider tools');
  }
  if (request.tools.length > 0 && request.outputSchema) {
    throw new Error('Google adapter does not combine custom tools with structured output');
  }
  return {
    model: request.model,
    contents: request.tools.length > 0
      ? toGoogleContents(request.messages)
      : request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: textOnly(message.content, 'messages') }],
      })),
    config: {
      systemInstruction: request.system.map((block) => block.text).join('\n\n'),
      maxOutputTokens: request.maxOutputTokens,
      ...(request.reasoning?.effort && request.reasoning.effort !== 'provider_default' && {
        thinkingConfig: {
          thinkingLevel: {
            low: ThinkingLevel.LOW,
            medium: ThinkingLevel.MEDIUM,
            high: ThinkingLevel.HIGH,
          }[request.reasoning.effort as 'low' | 'medium' | 'high'],
          includeThoughts: false,
        },
      }),
      ...(request.outputSchema && {
        responseMimeType: 'application/json',
        responseJsonSchema: request.outputSchema.schema,
      }),
      ...(request.tools.length > 0 && {
        tools: [{
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
          })),
        }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.VALIDATED,
            allowedFunctionNames: request.tools.map((tool) => tool.name),
          },
        },
      }),
    },
  };
}

function normalizeFinishReason(reason: string): ModelFinishReason {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(reason)) {
    return 'refusal';
  }
  throw new Error(`Unhandled Google finish reason: ${reason}`);
}

export function normalizeGoogleResponse(response: GenerateContentResponse): ModelResponse {
  if (typeof response.responseId !== 'string' || !response.responseId.trim() || response.responseId.length > 256) {
    throw new Error('Malformed Google response ID');
  }
  if (typeof response.modelVersion !== 'string' || !response.modelVersion.trim() || response.modelVersion.length > 256) {
    throw new Error('Malformed Google response model');
  }
  if (!response.usageMetadata) throw new Error('Malformed Google response usage');
  assertSafeCount(response.usageMetadata.promptTokenCount, 'input usage');
  if (response.usageMetadata.thoughtsTokenCount !== undefined) {
    assertSafeCount(response.usageMetadata.thoughtsTokenCount, 'thought usage');
  }
  if ((response.candidates?.length ?? 0) === 0 && response.promptFeedback?.blockReason) {
    const outputTokens = response.usageMetadata.candidatesTokenCount ?? 0;
    assertSafeCount(outputTokens, 'output usage');
    if (!Object.values(BlockedReason).includes(response.promptFeedback.blockReason)) {
      throw new Error('Malformed Google prompt block reason');
    }
    const refused = deepFreeze({
      provider: 'google',
      model: response.modelVersion,
      id: response.responseId,
      content: [],
      finishReason: 'refusal',
      providerFinishReason: `PROMPT_${response.promptFeedback.blockReason}`,
      usage: {
        inputTokens: response.usageMetadata.promptTokenCount,
        outputTokens: outputTokens + (response.usageMetadata.thoughtsTokenCount ?? 0),
      },
    } satisfies ModelResponse);
    validateNormalizedModelResponse(refused);
    return refused;
  }
  assertSafeCount(response.usageMetadata.candidatesTokenCount, 'output usage');
  if (!Array.isArray(response.candidates) || response.candidates.length !== 1) {
    throw new Error('Google response requires exactly one candidate');
  }
  const candidate = response.candidates[0];
  if (typeof candidate.finishReason !== 'string') throw new Error('Malformed Google finish reason');
  const finishReason = normalizeFinishReason(candidate.finishReason);
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) {
    if (finishReason !== 'refusal') throw new Error('Malformed Google response content');
  }
  if ((parts?.length ?? 0) > MAX_GOOGLE_RESPONSE_PARTS) {
    throw new Error('Google response content part limit exceeded');
  }
  const content: ModelMessageContent[] = [];
  for (const part of parts ?? []) {
    const keys = Object.keys(part).filter((key) => part[key as keyof typeof part] !== undefined);
    if (keys.some((key) => !['text', 'functionCall', 'thoughtSignature', 'thought'].includes(key))) {
      throw new Error('Unexpected Google response content');
    }
    if (part.thought !== undefined && part.thought !== false) throw new Error('Unexpected Google thought content');
    if (part.thoughtSignature !== undefined && (typeof part.thoughtSignature !== 'string' || part.thoughtSignature.length > 16_384)) {
      throw new Error('Malformed Google thought signature');
    }
    const hasText = part.text !== undefined;
    const hasFunctionCall = part.functionCall !== undefined;
    if (hasText === hasFunctionCall) throw new Error('Google response part requires exactly one payload');
    if (part.functionCall !== undefined) {
      const call = part.functionCall;
      const callKeys = Object.keys(call).filter((key) => call[key as keyof typeof call] !== undefined);
      // Gemini 3 supplies IDs for function calls. Missing IDs cannot be
      // correlated safely, so this adapter fails closed instead of inventing one.
      if (
        callKeys.some((key) => !['id', 'name', 'args'].includes(key))
        || typeof call.id !== 'string'
        || !call.id.trim()
        || call.id.length > 256
        || typeof call.name !== 'string'
        || !call.name.trim()
        || call.name.length > 128
        || typeof call.args !== 'object'
        || call.args === null
        || Array.isArray(call.args)
        || call.partialArgs !== undefined
        || call.willContinue !== undefined
      ) throw new Error('Malformed Google function call');
      assertPlainJson(call.args, 'Google function-call input');
      content.push(rememberGoogleContinuation({
        type: 'tool_call',
        id: call.id,
        name: call.name,
        input: call.args,
      } as const, part));
    } else {
      if (typeof part.text !== 'string') throw new Error('Malformed Google text content');
      content.push(rememberGoogleContinuation({ type: 'text', text: part.text } as const, part));
    }
  }
  if (candidate.content !== undefined && candidate.content.role !== 'model') {
    throw new Error('Malformed Google response role');
  }
  if (finishReason !== 'refusal' && content.length < 1) throw new Error('Empty Google response output');

  const hasToolCalls = content.some((item) => item.type === 'tool_call');
  if (hasToolCalls) {
    const firstFunctionPart = parts?.find((part) => part.functionCall !== undefined);
    if (
      typeof firstFunctionPart?.thoughtSignature !== 'string'
      || !firstFunctionPart.thoughtSignature.trim()
    ) throw new Error('Google function call is missing its thought signature');
  }
  if (hasToolCalls && finishReason !== 'stop') {
    throw new Error('Google function call has incompatible finish reason');
  }

  const normalized = deepFreeze({
    provider: 'google',
    model: response.modelVersion,
    id: response.responseId,
    content,
    finishReason: hasToolCalls ? 'tool_calls' : finishReason,
    providerFinishReason: candidate.finishReason,
    usage: {
      inputTokens: response.usageMetadata.promptTokenCount,
      outputTokens: response.usageMetadata.candidatesTokenCount + (response.usageMetadata.thoughtsTokenCount ?? 0),
      ...(response.usageMetadata.cachedContentTokenCount !== undefined && {
        cacheReadTokens: response.usageMetadata.cachedContentTokenCount,
      }),
    },
  } satisfies ModelResponse);
  validateNormalizedModelResponse(normalized);
  return normalized;
}

export class GoogleGenerateContentProvider implements ModelProvider {
  readonly id = 'google' as const;
  readonly capabilities = GOOGLE_GENERATE_CONTENT_CAPABILITIES;
  private readonly transport: GoogleGenerateContentTransport;

  constructor(apiKey: string, transport?: GoogleGenerateContentTransport) {
    if (transport) {
      this.transport = transport;
    } else {
      const client = new GoogleGenAI({
        apiKey,
        // One attempt means no SDK retry. The evaluation runner owns the
        // single-call budget and must observe every paid dispatch itself.
        httpOptions: { retryOptions: { attempts: 1 } },
      });
      this.transport = {
        models: {
          generateContent: (request, options) => client.models.generateContent({
            ...request,
            config: {
              ...request.config,
              abortSignal: options?.signal,
            },
          }),
        },
      };
    }
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    const providerRequest = (
      deepFreeze(structuredClone(toGoogleRequest(request)))
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
    if (options.signal?.aborted) throw options.signal.reason;
    await options.beforeDispatch?.(prepared);
    const response = await this.transport.models.generateContent(
      prepared.providerRequest as unknown as GenerateContentParameters,
      { signal: options.signal },
    );
    const normalized = normalizeGoogleResponse(response);
    if (normalized.model !== request.model && !normalized.model.startsWith(`${request.model}-`)) {
      throw new UnexpectedModelIdentityError('google', request.model, normalized.model);
    }
    yield { type: 'response_start', provider: this.id, model: normalized.model, id: normalized.id };
    for (const [index, item] of normalized.content.entries()) {
      if (item.type === 'text') yield { type: 'text_delta', index, text: item.text };
      else if (item.type === 'tool_call') yield { type: 'tool_call', index, call: item };
      else throw new Error('Google adapter emitted unsupported content');
    }
    yield { type: 'response_complete', response: normalized };
  }
}
