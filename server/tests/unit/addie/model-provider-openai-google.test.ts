import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'openai/resources/responses/responses';
import type { GenerateContentResponse } from '@google/genai';
import { collectModelResponse } from '../../../src/addie/model-providers/events.js';
import {
  OPENAI_ROUTER_MODEL,
  OpenAIResponsesProvider,
  normalizeOpenAIResponse,
  type OpenAIResponsesTransport,
} from '../../../src/addie/model-providers/openai-responses-provider.js';
import {
  GOOGLE_ROUTER_MODEL,
  GoogleGenerateContentProvider,
  normalizeGoogleResponse,
  type GoogleGenerateContentTransport,
} from '../../../src/addie/model-providers/google-generate-content-provider.js';
import type { ModelRequest } from '../../../src/addie/model-providers/model-provider.js';

function request(model: string, overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model,
    system: [{ text: 'Route this request.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    maxOutputTokens: 300,
    ...overrides,
  };
}

function openAIResponse(overrides: Record<string, unknown> = {}): Response {
  return {
    id: 'resp_1',
    model: OPENAI_ROUTER_MODEL,
    status: 'completed',
    incomplete_details: null,
    output: [{
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '{"action":"ignore","reason":"done"}', annotations: [] }],
    }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
    ...overrides,
  } as Response;
}

function googleResponse(overrides: Record<string, unknown> = {}): GenerateContentResponse {
  return {
    responseId: 'google_1',
    modelVersion: GOOGLE_ROUTER_MODEL,
    candidates: [{
      finishReason: 'STOP',
      content: { role: 'model', parts: [{ text: '{"action":"ignore","reason":"done"}' }] },
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    ...overrides,
  } as GenerateContentResponse;
}

describe('OpenAIResponsesProvider', () => {
  it('builds a frozen, store-free structured-output request', () => {
    const provider = new OpenAIResponsesProvider('unused', {} as OpenAIResponsesTransport);
    const prepared = provider.prepare(request(OPENAI_ROUTER_MODEL, {
      outputSchema: {
        name: 'plan',
        schema: { type: 'object', properties: { action: { type: 'string' } } },
      },
      reasoning: { effort: 'low' },
    }));
    expect(prepared.providerRequest).toEqual({
      model: OPENAI_ROUTER_MODEL,
      instructions: 'Route this request.',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      max_output_tokens: 300,
      store: false,
      background: false,
      stream: false,
      truncation: 'disabled',
      parallel_tool_calls: false,
      tools: [],
      text: {
        format: {
          type: 'json_schema',
          name: 'plan',
          schema: { type: 'object', properties: { action: { type: 'string' } } },
          strict: true,
        },
      },
      reasoning: { effort: 'low' },
    });
    expect(Object.isFrozen(prepared.providerRequest)).toBe(true);
    expect(Object.isFrozen(prepared.providerRequest.input)).toBe(true);
  });

  it('dispatches exactly once with SDK retries disabled', async () => {
    const create = vi.fn().mockResolvedValue(openAIResponse());
    const provider = new OpenAIResponsesProvider('unused', { responses: { create } });
    const beforeDispatch = vi.fn();
    const normalized = await collectModelResponse(
      provider.respond(request(OPENAI_ROUTER_MODEL), { beforeDispatch }),
      'openai',
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toEqual({ maxRetries: 0, signal: undefined });
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(normalized.finishReason).toBe('stop');
    expect(normalized.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 });
  });

  it('fails closed on unsupported models, tools, cache hints, and non-text input', () => {
    const provider = new OpenAIResponsesProvider('unused', {} as OpenAIResponsesTransport);
    expect(() => provider.prepare(request('gpt-other'))).toThrow('Unsupported OpenAI router model');
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { tools: [{ name: 'x', description: 'x', inputSchema: {} }] }))).toThrow();
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { system: [{ text: 'x', cacheHint: 'ephemeral' }] }))).toThrow('cache hints');
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'x' }] }] }))).toThrow();
  });

  it('rejects incomplete, unexpected, and malformed responses', () => {
    expect(() => normalizeOpenAIResponse(openAIResponse({ status: 'queued' }))).toThrow('Nonterminal');
    expect(() => normalizeOpenAIResponse(openAIResponse({ output: [{ type: 'function_call' }] }))).toThrow('Unexpected');
    expect(() => normalizeOpenAIResponse(openAIResponse({ usage: undefined }))).toThrow('usage');
    expect(normalizeOpenAIResponse(openAIResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'incomplete', content: [] }],
    })).finishReason).toBe('length');
    expect(normalizeOpenAIResponse(openAIResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [],
    })).finishReason).toBe('refusal');
  });
});

describe('GoogleGenerateContentProvider', () => {
  it('builds the exact frozen generateContent request', () => {
    const provider = new GoogleGenerateContentProvider('unused', {} as GoogleGenerateContentTransport);
    const prepared = provider.prepare(request(GOOGLE_ROUTER_MODEL, {
      outputSchema: { name: 'plan', schema: { type: 'object' } },
    }));
    expect(prepared.providerRequest).toEqual({
      model: GOOGLE_ROUTER_MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      config: {
        systemInstruction: 'Route this request.',
        maxOutputTokens: 300,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
      },
    });
    expect(Object.isFrozen(prepared.providerRequest)).toBe(true);
    expect(Object.isFrozen(prepared.providerRequest.contents)).toBe(true);
    expect(provider.prepare(request(GOOGLE_ROUTER_MODEL, { reasoning: { effort: 'low' } })).providerRequest).toMatchObject({
      config: { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: false } },
    });
  });

  it('dispatches exactly once and normalizes usage', async () => {
    const generateContent = vi.fn().mockResolvedValue(googleResponse({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 18 },
      candidates: [{
        finishReason: 'STOP',
        content: { role: 'model', parts: [{ text: '{"action":"ignore","reason":"done"}', thoughtSignature: 'opaque', thought: false }] },
      }],
    }));
    const provider = new GoogleGenerateContentProvider('unused', { models: { generateContent } });
    const beforeDispatch = vi.fn();
    const normalized = await collectModelResponse(
      provider.respond(request(GOOGLE_ROUTER_MODEL), { beforeDispatch }),
      'google',
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(normalized.finishReason).toBe('stop');
    expect(normalized.usage).toEqual({ inputTokens: 10, outputTokens: 8 });
  });

  it('fails closed on unsupported capabilities and malformed responses', () => {
    const provider = new GoogleGenerateContentProvider('unused', {} as GoogleGenerateContentTransport);
    expect(() => provider.prepare(request('gemini-other'))).toThrow('Unsupported Google router model');
    expect(() => provider.prepare(request(GOOGLE_ROUTER_MODEL, { reasoning: { effort: 'none' } }))).toThrow();
    expect(() => normalizeGoogleResponse(googleResponse({ candidates: [] }))).toThrow('exactly one');
    expect(() => normalizeGoogleResponse(googleResponse({ usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 1 } }))).toThrow('usage');
    expect(() => normalizeGoogleResponse(googleResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'x' } }] } }] }))).toThrow('Unexpected');
    expect(normalizeGoogleResponse(googleResponse({
      candidates: [],
      promptFeedback: { blockReason: 'SAFETY' },
      usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 },
    })).finishReason).toBe('refusal');
    expect(() => normalizeGoogleResponse(googleResponse({
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, thoughtsTokenCount: -1 },
    }))).toThrow('thought usage');
  });

  it('propagates an abort signal in the exact request seen before dispatch', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('aborted'));
    const provider = new GoogleGenerateContentProvider('unused', { models: { generateContent } });
    const controller = new AbortController();
    let seenRequest: unknown;
    const consumed = collectModelResponse(provider.respond(request(GOOGLE_ROUTER_MODEL), {
      signal: controller.signal,
      beforeDispatch: (prepared) => { seenRequest = prepared.providerRequest; },
    }), 'google');
    await expect(consumed).rejects.toThrow('aborted');
    expect(generateContent.mock.calls[0][0]).toBe(seenRequest);
    expect(generateContent.mock.calls[0][0].config.abortSignal).toBeUndefined();
    expect(generateContent.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });
});
