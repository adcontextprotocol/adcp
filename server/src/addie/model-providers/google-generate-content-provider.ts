import {
  BlockedReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponse,
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
import { validateModelCapabilities } from './capabilities.js';
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
    throw new Error(`Malformed Google ${label}`);
  }
}

function textOnly(content: ModelMessageContent[], label: string): string {
  if (content.length < 1 || content.some((block) => block.type !== 'text')) {
    throw new Error(`Google router adapter requires text-only ${label}`);
  }
  return content.map((block) => block.type === 'text' ? block.text : '').join('');
}

function toGoogleRequest(request: ModelRequest): GenerateContentParameters {
  validateModelCapabilities('google', GOOGLE_GENERATE_CONTENT_CAPABILITIES, request);
  if (request.model !== GOOGLE_ROUTER_MODEL) {
    throw new Error(`Unsupported Google router model: ${request.model}`);
  }
  if (request.system.some((block) => block.cacheHint !== undefined)) {
    throw new Error('Google router adapter does not support cache hints');
  }
  if (request.tools.length > 0 || (request.providerTools?.length ?? 0) > 0) {
    throw new Error('Google router adapter is tool-free');
  }
  return {
    model: request.model,
    contents: request.messages.map((message) => ({
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
  const content: ModelMessageContent[] = [];
  for (const part of parts ?? []) {
    const keys = Object.keys(part).filter((key) => part[key as keyof typeof part] !== undefined);
    if (keys.some((key) => key !== 'text' && key !== 'thoughtSignature' && key !== 'thought')) throw new Error('Unexpected Google response content');
    if (part.thought !== undefined && part.thought !== false) throw new Error('Unexpected Google thought content');
    if (part.thoughtSignature !== undefined && (typeof part.thoughtSignature !== 'string' || part.thoughtSignature.length > 16_384)) {
      throw new Error('Malformed Google thought signature');
    }
    if (typeof part.text !== 'string') throw new Error('Malformed Google text content');
    content.push({ type: 'text', text: part.text });
  }
  if (finishReason !== 'refusal' && content.length < 1) throw new Error('Empty Google response output');

  const normalized = deepFreeze({
    provider: 'google',
    model: response.modelVersion,
    id: response.responseId,
    content,
    finishReason,
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
      const client = new GoogleGenAI({ apiKey });
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
      if (item.type !== 'text') throw new Error('Google router adapter emitted non-text content');
      yield { type: 'text_delta', index, text: item.text };
    }
    yield { type: 'response_complete', response: normalized };
  }
}
