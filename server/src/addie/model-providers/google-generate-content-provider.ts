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
import {
  createModelProviderAdapterError,
  UnexpectedModelIdentityError,
} from './model-provider.js';
import { assertPlainJson, validateModelCapabilities } from './capabilities.js';
import { validateNormalizedModelResponse } from './events.js';

export const GOOGLE_ROUTER_MODEL = 'gemini-3.7-flash';
export const GOOGLE_DIRECT_FULL_SUITE_MODEL = 'gemini-3.8-flash';
const GOOGLE_ROUTER_REVIEWED_REVISIONS = new Set([
  'gemini-3.7-flash-20260801',
]);

/** Provider-returned dated revisions accepted for the frozen router model. */
export function isGoogleRouterModelRevision(model: string): boolean {
  return model === GOOGLE_ROUTER_MODEL || GOOGLE_ROUTER_REVIEWED_REVISIONS.has(model);
}

export function isGoogleGenerateContentAllowedModel(
  model: string,
  directFullSuiteScope = false,
): model is typeof GOOGLE_ROUTER_MODEL | typeof GOOGLE_DIRECT_FULL_SUITE_MODEL {
  return model === GOOGLE_ROUTER_MODEL
    || (directFullSuiteScope && model === GOOGLE_DIRECT_FULL_SUITE_MODEL);
}

/** Gemini 3.7 has its existing dated-revision exception; 3.8 remains exact. */
export function googleReturnedModelIdentityMatches(requestedModel: string, returnedModel: string): boolean {
  return requestedModel === GOOGLE_ROUTER_MODEL
    ? isGoogleRouterModelRevision(returnedModel)
    : requestedModel === GOOGLE_DIRECT_FULL_SUITE_MODEL
      && returnedModel === GOOGLE_DIRECT_FULL_SUITE_MODEL;
}

export interface GoogleGenerateContentTransport {
  models: {
    generateContent(
      request: GenerateContentParameters,
      options?: { signal?: AbortSignal },
    ): Promise<GenerateContentResponse>;
    generateContentStream?(
      request: GenerateContentParameters,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<GenerateContentResponse>>;
  };
}

export const GOOGLE_GENERATE_CONTENT_CAPABILITIES: ModelProviderCapabilities = Object.freeze({
  streaming: true,
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

/** Preserve original parts (including empty signed parts) across streamed chunks. */
async function collectGoogleStream(
  chunks: AsyncIterable<GenerateContentResponse>,
  options: ModelRespondOptions,
): Promise<GenerateContentResponse> {
  const result = {} as GenerateContentResponse;
  const parts: Part[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    if (options.signal?.aborted) throw options.signal.reason;
    for (const key of ['responseId', 'modelVersion'] as const) {
      if (chunk[key] !== undefined) {
        if (result[key] && result[key] !== chunk[key]) throw new Error('Google stream identity changed');
        result[key] = chunk[key];
      }
    }
    if (chunk.usageMetadata) result.usageMetadata = chunk.usageMetadata;
    if (chunk.promptFeedback) result.promptFeedback = chunk.promptFeedback;
    if (chunk.candidates !== undefined) {
      if (chunk.candidates.length !== 1) throw new Error('Google stream requires one candidate');
      const candidate = chunk.candidates[0];
      const previous = result.candidates?.[0];
      if (previous?.finishReason && candidate.content?.parts?.length) {
        throw new Error('Google stream continued after completion');
      }
      for (const part of candidate.content?.parts ?? []) {
        bytes += Buffer.byteLength(JSON.stringify(part), 'utf8');
        if (parts.length >= MAX_GOOGLE_RESPONSE_PARTS || bytes > MAX_GOOGLE_CONTINUATION_BYTES) {
          throw new Error('Google stream exceeds content limit');
        }
        parts.push(part);
        options.onStreamProgress?.({ type: 'content_delta' });
      }
      result.candidates = [{
        ...previous, ...candidate,
        ...(parts.length > 0 && { content: { role: candidate.content?.role ?? previous?.content?.role, parts } }),
      }];
    }
  }
  return result;
}

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

/** Read only a conventional HTTP receipt from an untrusted SDK exception. */
function googleTransportHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  for (const key of ['status', 'statusCode'] as const) {
    try {
      // A data descriptor lets us reject accessors without invoking them. A
      // proxy that prevents descriptor inspection is likewise absent evidence.
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const value = descriptor.value;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
        return value;
      }
    } catch {
      // An SDK proxy is not receipt evidence.
      return undefined;
    }
  }
  return undefined;
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

function toGoogleRequest(
  request: ModelRequest,
  directFullSuiteScope: boolean,
): GenerateContentParameters {
  validateModelCapabilities('google', GOOGLE_GENERATE_CONTENT_CAPABILITIES, request);
  if (!isGoogleGenerateContentAllowedModel(request.model, directFullSuiteScope)) {
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
            mode: request.toolChoice?.type === 'required' || request.toolChoice?.type === 'tool'
              ? FunctionCallingConfigMode.ANY
              : FunctionCallingConfigMode.VALIDATED,
            allowedFunctionNames: request.toolChoice?.type === 'tool'
              ? [request.toolChoice.name]
              : request.tools.map((tool) => tool.name),
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
    assertSafeCount(response.usageMetadata.candidatesTokenCount, 'output usage');
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
        outputTokens: response.usageMetadata.candidatesTokenCount + (response.usageMetadata.thoughtsTokenCount ?? 0),
        ...(response.usageMetadata.thoughtsTokenCount !== undefined && {
          // A breakdown of outputTokens, not an additional billable total.
          reasoningTokens: response.usageMetadata.thoughtsTokenCount,
        }),
      },
    } satisfies ModelResponse);
    validateNormalizedModelResponse(refused);
    return refused;
  }
  if (!Array.isArray(response.candidates) || response.candidates.length !== 1) {
    throw new Error('Google response requires exactly one candidate');
  }
  const candidate = response.candidates[0];
  if (typeof candidate.finishReason !== 'string') throw new Error('Malformed Google finish reason');
  const finishReason = normalizeFinishReason(candidate.finishReason);
  const hasOmittedCandidateOutputUsage = response.usageMetadata.candidatesTokenCount === undefined;
  if (!hasOmittedCandidateOutputUsage) {
    assertSafeCount(response.usageMetadata.candidatesTokenCount, 'output usage');
  }
  const parts = candidate.content?.parts;
  if (candidate.content === undefined) {
    // Gemini can omit content after a bounded reasoning turn consumes its
    // output allowance. No other terminal state may omit its content object.
    if (finishReason !== 'length') throw new Error('Malformed Google response content');
  } else if (!Array.isArray(parts)) {
    throw new Error('Malformed Google response content');
  }
  if ((parts?.length ?? 0) > MAX_GOOGLE_RESPONSE_PARTS) {
    throw new Error('Google response content part limit exceeded');
  }
  // Gemini can omit the visible-candidate count only when a bounded reasoning
  // turn consumes its output allowance before emitting a candidate payload.
  // Its validated thoughts count remains part of the actual billed output usage.
  if (hasOmittedCandidateOutputUsage && (finishReason !== 'length' || (parts?.length ?? 0) !== 0)) {
    throw new Error('Malformed Google output usage');
  }
  const outputTokens = response.usageMetadata.candidatesTokenCount ?? 0;
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
  // A bounded reasoning turn can consume its complete output allowance before
  // emitting visible text. It is still a settled MAX_TOKENS receipt, not an
  // unknown provider exposure; retain its normalized usage and let the
  // evaluator record the explicit truncated outcome. Empty STOP responses
  // remain invalid.
  if (finishReason !== 'refusal' && finishReason !== 'length' && content.length < 1) throw new Error('Empty Google response output');

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
      outputTokens: outputTokens + (response.usageMetadata.thoughtsTokenCount ?? 0),
      ...(response.usageMetadata.thoughtsTokenCount !== undefined && {
        reasoningTokens: response.usageMetadata.thoughtsTokenCount,
      }),
      ...(response.usageMetadata.cachedContentTokenCount !== undefined && {
        cacheReadTokens: response.usageMetadata.cachedContentTokenCount,
      }),
    },
  } satisfies ModelResponse);
  validateNormalizedModelResponse(normalized);
  return normalized;
}

/**
 * Pure evaluator request projection. This deliberately owns neither a client
 * nor a transport: callers can inspect a frozen request, but cannot use this
 * helper to inject executable Google dispatch into the paid authority.
 */
export function prepareGoogleGenerateContentEvaluationRequest(
  request: ModelRequest,
): Readonly<GenerateContentParameters> {
  return deepFreeze(structuredClone(toGoogleRequest(request, true)));
}

export class GoogleGenerateContentProvider implements ModelProvider {
  readonly id = 'google' as const;
  readonly capabilities = GOOGLE_GENERATE_CONTENT_CAPABILITIES;
  private readonly transport: GoogleGenerateContentTransport;
  private readonly directFullSuiteScope: boolean;

  constructor(
    apiKey: string,
    transport?: GoogleGenerateContentTransport,
  ) {
    // The ordinary adapter accepts the reviewed Gemini 3.7 model. Gemini 3.8 request
    // construction is a pure helper consumed inside the sealed authority;
    // no public constructor or factory can opt an injected transport into the
    // evaluator's paid model scope.
    this.directFullSuiteScope = false;
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
          generateContentStream: (request, options) => client.models.generateContentStream({
            ...request,
            config: { ...request.config, abortSignal: options?.signal },
          }),
        },
      };
    }
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    const providerRequest = (
      deepFreeze(structuredClone(toGoogleRequest(request, this.directFullSuiteScope)))
    ) as unknown as Readonly<Record<string, unknown>>;
    return deepFreeze({
      provider: this.id,
      model: request.model,
      capabilities: this.capabilities,
      requestMetadata: request.requestMetadata,
      providerRequest,
    });
  }

  /** Preserve opaque Google continuation parts when an evaluator snapshots a response. */
  snapshotResponse(response: ModelResponse): ModelResponse {
    const snapshot = structuredClone(response);
    for (const [index, content] of response.content.entries()) {
      const continuation = googleContinuationParts.get(content);
      const clonedContent = snapshot.content[index];
      if (continuation && clonedContent) rememberGoogleContinuation(clonedContent, continuation);
    }
    return deepFreeze(snapshot);
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    validateModelCapabilities(this.id, this.capabilities, request, { streaming: options.stream });
    if (options.stream && !this.transport.models.generateContentStream) {
      throw new Error('Google transport does not support streaming');
    }
    const prepared = this.prepare(request);
    if (options.signal?.aborted) throw options.signal.reason;
    await options.beforeDispatch?.(prepared);
    let response: GenerateContentResponse;
    try {
      const payload = prepared.providerRequest as unknown as GenerateContentParameters;
      response = options.stream
        ? await collectGoogleStream(await this.transport.models.generateContentStream!(payload, { signal: options.signal }), options)
        : await this.transport.models.generateContent(payload, { signal: options.signal });
    } catch (error) {
      // Do not expose provider error fields here. The runner receives a
      // constant-message adapter error plus the only safe receipt field.
      // A post-dispatch abort is terminal. Do not inspect a provider-owned
      // rejection in that case: even descriptor inspection can invoke a
      // hostile proxy trap before the runner can record its timeout.
      if (options.signal?.aborted) {
        throw createModelProviderAdapterError('provider_transport');
      }
      throw createModelProviderAdapterError(
        'provider_transport',
        googleTransportHttpStatus(error),
      );
    }
    let normalized: ModelResponse;
    try {
      normalized = normalizeGoogleResponse(response);
    } catch {
      throw createModelProviderAdapterError('adapter_response_normalization');
    }
    if (!googleReturnedModelIdentityMatches(request.model, normalized.model)) {
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
