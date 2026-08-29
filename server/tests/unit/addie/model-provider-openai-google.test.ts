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
import {
  UnsupportedModelCapabilityError,
  type ModelRequest,
} from '../../../src/addie/model-providers/model-provider.js';
import {
  executeReadOnlyToolLoop,
  ReadOnlyToolLoopBoundaryError,
} from '../../../src/addie/model-providers/read-only-tool-loop.js';
import { createOfficialDocsReadOnlyToolBoundary } from '../../../src/addie/jobs/official-docs-read-only-tools.js';
import { executeFixedTraceToolLoop } from '../../../src/addie/eval/fixed-trace-tool-loop.js';
import { FIXED_TRACE_SUITE } from '../../../src/addie/eval/fixed-trace-suite.js';

const { googleGenAIConstructor } = vi.hoisted(() => ({
  googleGenAIConstructor: vi.fn(function FakeGoogleGenAI() {
    return { models: { generateContent: vi.fn() } };
  }),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: googleGenAIConstructor };
});

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

const allowPureLocalTool = () => ({ allowed: true as const });

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
  it.each([
    [{ type: 'auto' as const }, 'auto'],
    [{ type: 'required' as const }, 'required'],
    [{ type: 'tool' as const, name: 'search_docs' }, { type: 'function', name: 'search_docs' }],
  ])('translates canonical %o tool choice', (toolChoice, expected) => {
    const provider = new OpenAIResponsesProvider('unused', {} as OpenAIResponsesTransport);
    const prepared = provider.prepare(request(OPENAI_ROUTER_MODEL, {
      tools: [{ name: 'search_docs', description: 'Search.', inputSchema: { type: 'object' } }],
      toolChoice,
    }));

    expect(prepared.providerRequest).toMatchObject({ tool_choice: expected });
  });

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

  it('projects custom tools and stateless function-call continuation exactly', () => {
    const provider = new OpenAIResponsesProvider('unused', {} as OpenAIResponsesTransport);
    const prepared = provider.prepare(request(OPENAI_ROUTER_MODEL, {
      tools: [{
        name: 'search_docs',
        description: 'Search official docs.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find the task model.' }] },
        { role: 'assistant', content: [{
          type: 'tool_call',
          id: 'call_1',
          name: 'search_docs',
          input: { query: 'task model' },
        }] },
        { role: 'user', content: [{
          type: 'tool_result',
          toolCallId: 'call_1',
          toolName: 'search_docs',
          content: 'The protocol is task based.',
        }] },
      ],
    }));

    expect(prepared.providerRequest).toMatchObject({
      input: [
        { type: 'message', role: 'user', content: 'Find the task model.' },
        { type: 'function_call', call_id: 'call_1', name: 'search_docs', arguments: '{"query":"task model"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'The protocol is task based.' },
      ],
      tools: [{
        type: 'function',
        name: 'search_docs',
        description: 'Search official docs.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        strict: false,
      }],
      parallel_tool_calls: false,
    });
  });

  it('marks failed tool results explicitly in Responses continuation output', () => {
    const provider = new OpenAIResponsesProvider('unused', {} as OpenAIResponsesTransport);
    const prepared = provider.prepare(request(OPENAI_ROUTER_MODEL, {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find the task model.' }] },
        { role: 'assistant', content: [{
          type: 'tool_call', id: 'call_1', name: 'search_docs', input: { query: 'task model' },
        }] },
        { role: 'user', content: [{
          type: 'tool_result', toolCallId: 'call_1', toolName: 'search_docs', content: '', isError: true,
        }] },
      ],
    }));

    expect(prepared.providerRequest.input).toEqual([
      { type: 'message', role: 'user', content: 'Find the task model.' },
      { type: 'function_call', call_id: 'call_1', name: 'search_docs', arguments: '{"query":"task model"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '[Tool execution error]\nNo error details provided.' },
    ]);
  });

  it('normalizes and emits function calls through the shared event boundary', async () => {
    const create = vi.fn().mockResolvedValue(openAIResponse({
      output: [{
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'search_docs',
        arguments: '{"query":"task model"}',
        status: 'completed',
      }],
    }));
    const provider = new OpenAIResponsesProvider('unused', { responses: { create } });
    const normalized = await collectModelResponse(provider.respond(request(OPENAI_ROUTER_MODEL, {
      tools: [{ name: 'search_docs', description: 'Search.', inputSchema: { type: 'object' } }],
    })), 'openai');

    expect(normalized).toMatchObject({
      finishReason: 'tool_calls',
      content: [{
        type: 'tool_call',
        id: 'call_1',
        name: 'search_docs',
        input: { query: 'task model' },
      }],
    });
  });

  it('round-trips function results through the normalized fixed-trace loop', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(openAIResponse({
        id: 'resp_tool',
        output: [{
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'search_docs',
          arguments: '{"query":"task model"}',
          status: 'completed',
        }],
      }))
      .mockResolvedValueOnce(openAIResponse({
        id: 'resp_final',
        output: [{
          id: 'msg_final',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'The protocol uses task-based interactions.', annotations: [] }],
        }],
      }));
    const provider = new OpenAIResponsesProvider('unused', { responses: { create } });
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-task-model')!;
    const definitions = trace.toolFixtures.map((fixture) => ({
      name: fixture.name,
      description: `Synthetic ${fixture.name}.`,
      replaySafety: 'pure_local' as const,
      input_schema: fixture.name === 'search_docs'
        ? {
            type: 'object' as const,
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          }
        : {
            type: 'object' as const,
            properties: { doc_id: { type: 'string' } },
            required: ['doc_id'],
            additionalProperties: false,
          },
    }));

    const result = await executeFixedTraceToolLoop(
      provider,
      request(OPENAI_ROUTER_MODEL),
      trace,
      definitions,
      { maxIterations: 3 },
    );

    expect(result).toMatchObject({
      iterations: 2,
      text: 'The protocol uses task-based interactions.',
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 0 },
      tools: [{ name: 'search_docs', simulated: true, policyDisposition: 'allowed' }],
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toMatchObject({
      input: expect.arrayContaining([
        { type: 'function_call', call_id: 'call_1', name: 'search_docs', arguments: '{"query":"task model"}' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: expect.stringContaining('Official docs: AdCP uses task-based interactions'),
        },
      ]),
    });
  });

  it('fails closed when streaming transport is requested', async () => {
    const provider = new OpenAIResponsesProvider('unused', {} as OpenAIResponsesTransport);
    await expect(collectModelResponse(
      provider.respond(request(OPENAI_ROUTER_MODEL), { stream: true }),
    )).rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
  });

  it('omits unavailable optional cache usage fields', () => {
    const withoutEither = normalizeOpenAIResponse(openAIResponse({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: {},
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }));
    const withoutWrite = normalizeOpenAIResponse(openAIResponse({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }));
    const withoutRead = normalizeOpenAIResponse(openAIResponse({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cache_write_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }));
    expect(withoutEither.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(withoutWrite.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 });
    expect(withoutRead.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheWriteTokens: 3 });
  });

  it('fails closed on unsupported models, provider tools, cache hints, and unsupported input', () => {
    const provider = new OpenAIResponsesProvider('unused', {} as OpenAIResponsesTransport);
    expect(() => provider.prepare(request('gpt-other'))).toThrow('Unsupported OpenAI router model');
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { providerTools: [{ type: 'web_search' }] }))).toThrow('providerWebSearch');
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { system: [{ text: 'x', cacheHint: 'ephemeral' }] }))).toThrow('cache hints');
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'x' }] }] }))).toThrow();
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { messages: [{ role: 'user', content: [{ type: 'tool_call', id: 'x', name: 'x', input: {} }] }] }))).toThrow('does not support tool_call');
    expect(() => provider.prepare(request(OPENAI_ROUTER_MODEL, { messages: [{ role: 'user', content: [] }] }))).toThrow('non-empty');
  });

  it('rejects incomplete, unexpected, and malformed responses', () => {
    expect(() => normalizeOpenAIResponse(openAIResponse({ status: 'queued' }))).toThrow('Nonterminal');
    expect(() => normalizeOpenAIResponse(openAIResponse({ output: [{ type: 'function_call' }] }))).toThrow('Malformed');
    expect(() => normalizeOpenAIResponse(openAIResponse({
      output: [{
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_docs',
        arguments: 'not-json', status: 'completed',
      }],
    }))).toThrow('arguments');
    expect(() => normalizeOpenAIResponse(openAIResponse({
      output: [{
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_docs',
        arguments: '[]', status: 'completed',
      }],
    }))).toThrow('arguments');
    expect(() => normalizeOpenAIResponse(openAIResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_docs',
        arguments: '{}', status: 'completed',
      }],
    }))).toThrow('before function calls were terminal');
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
  it.each([
    [{ type: 'auto' as const }, 'VALIDATED', ['search_docs', 'get_doc']],
    [{ type: 'required' as const }, 'ANY', ['search_docs', 'get_doc']],
    [{ type: 'tool' as const, name: 'search_docs' }, 'ANY', ['search_docs']],
  ])('translates canonical %o tool choice', (toolChoice, mode, allowedFunctionNames) => {
    const provider = new GoogleGenerateContentProvider('unused', {} as GoogleGenerateContentTransport);
    const prepared = provider.prepare(request(GOOGLE_ROUTER_MODEL, {
      tools: [
        { name: 'search_docs', description: 'Search.', inputSchema: { type: 'object' } },
        { name: 'get_doc', description: 'Read.', inputSchema: { type: 'object' } },
      ],
      toolChoice,
    }));

    expect(prepared.providerRequest).toMatchObject({
      config: { toolConfig: { functionCallingConfig: { mode, allowedFunctionNames } } },
    });
  });

  it('disables SDK retries in the default transport', () => {
    googleGenAIConstructor.mockClear();
    new GoogleGenerateContentProvider('test-key');
    expect(googleGenAIConstructor).toHaveBeenCalledWith({
      apiKey: 'test-key',
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  });

  it('fails closed when streaming transport is requested', async () => {
    const provider = new GoogleGenerateContentProvider(
      'unused',
      {} as GoogleGenerateContentTransport,
    );
    await expect(collectModelResponse(
      provider.respond(request(GOOGLE_ROUTER_MODEL), { stream: true }),
    )).rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
  });

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
    expect(() => normalizeGoogleResponse(googleResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'x' } }] } }] }))).toThrow('Malformed Google function call');
    expect(() => normalizeGoogleResponse(googleResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hidden', functionCall: { id: 'x', name: 'search_docs', args: {} } }] } }] }))).toThrow('exactly one payload');
    expect(() => normalizeGoogleResponse(googleResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { id: 'x', name: 'search_docs', args: [] } }] } }] }))).toThrow('Malformed Google function call');
    expect(() => normalizeGoogleResponse(googleResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ functionCall: { id: 'x', name: 'search_docs', args: {} }, thoughtSignature: 'sig' }] } }] }))).toThrow('incompatible finish reason');
    expect(normalizeGoogleResponse(googleResponse({
      candidates: [],
      promptFeedback: { blockReason: 'SAFETY' },
      usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 },
    })).finishReason).toBe('refusal');
    expect(normalizeGoogleResponse(googleResponse({
      candidates: [{ finishReason: 'SAFETY' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 0, totalTokenCount: 4 },
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

  it('completes a provider-neutral read-only tool loop with exact Gemini continuation state', async () => {
    const generateContent = vi.fn()
      .mockResolvedValueOnce(googleResponse({
        responseId: 'google_tool_1',
        candidates: [{
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                id: 'call_1',
                name: 'search_docs',
                args: { query: 'protocol versions' },
              },
              thoughtSignature: 'opaque-signature',
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
      }))
      .mockResolvedValueOnce(googleResponse({
        responseId: 'google_tool_2',
        candidates: [{
          finishReason: 'STOP',
          content: { role: 'model', parts: [{ text: 'AdCP has versioned documentation.' }] },
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
      }));
    const provider = new GoogleGenerateContentProvider('unused', { models: { generateContent } });
    const handler = vi.fn().mockResolvedValue('Found the versioning guide.');
    const handlerFactory = vi.fn().mockReturnValue(new Map([
      ['search_docs', handler],
      ['get_doc', vi.fn().mockResolvedValue('Full document.')],
    ]));
    const beforeDispatch = vi.fn();
    const boundary = createOfficialDocsReadOnlyToolBoundary(handlerFactory);

    const result = await executeReadOnlyToolLoop(
      provider,
      request(GOOGLE_ROUTER_MODEL),
      boundary.tools,
      { beforeDispatch, authorizeToolExecution: boundary.authorizeToolExecution },
    );

    expect(handlerFactory).toHaveBeenCalledWith({ disableSearchTelemetry: true });
    expect(handler).toHaveBeenCalledWith({ query: 'protocol versions' });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[0][0].config).toMatchObject({
      tools: [{ functionDeclarations: [{ name: 'search_docs' }, { name: 'get_doc' }] }],
      toolConfig: {
        functionCallingConfig: {
          mode: 'VALIDATED',
          allowedFunctionNames: ['search_docs', 'get_doc'],
        },
      },
    });
    expect(generateContent.mock.calls[1][0].contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_1',
            name: 'search_docs',
            args: { query: 'protocol versions' },
          },
          thoughtSignature: 'opaque-signature',
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_1',
            name: 'search_docs',
            response: { output: 'Found the versioning guide.' },
          },
        }],
      },
    ]);
    expect(result.text).toBe('AdCP has versioned documentation.');
    expect(result.iterations).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 11 });
    expect(result.toolExecutions).toEqual([{
      sequence: 1,
      toolName: 'search_docs',
      disposition: 'succeeded',
    }]);
  });

  it('blocks unsafe and unknown tools before their handlers execute', async () => {
    const unsafeDispatch = vi.fn();
    const unsafeProvider = new GoogleGenerateContentProvider('unused', {
      models: { generateContent: unsafeDispatch },
    });
    await expect(executeReadOnlyToolLoop(unsafeProvider, request(GOOGLE_ROUTER_MODEL), [{
      definition: { name: 'mutate', description: 'mutate', inputSchema: { type: 'object' } },
      replaySafety: 'mutation',
      handler: vi.fn(),
    }], { authorizeToolExecution: allowPureLocalTool })).rejects.toMatchObject({ reason: 'unsafe_tool_classification' });
    expect(unsafeDispatch).not.toHaveBeenCalled();

    const generateContent = vi.fn().mockResolvedValue(googleResponse({
      candidates: [{
        finishReason: 'STOP',
        content: { role: 'model', parts: [{ functionCall: { id: 'x', name: 'unknown', args: {} }, thoughtSignature: 'sig' }] },
      }],
    }));
    const handler = vi.fn();
    const provider = new GoogleGenerateContentProvider('unused', { models: { generateContent } });
    await expect(executeReadOnlyToolLoop(provider, request(GOOGLE_ROUTER_MODEL), [{
      definition: { name: 'search_docs', description: 'search', inputSchema: { type: 'object' } },
      replaySafety: 'pure_local',
      handler,
    }], { authorizeToolExecution: allowPureLocalTool })).rejects.toEqual(new ReadOnlyToolLoopBoundaryError('unknown_tool_call'));
    expect(handler).not.toHaveBeenCalled();

    const invalidHandler = vi.fn();
    const invalidProvider = new GoogleGenerateContentProvider('unused', {
      models: {
        generateContent: vi.fn().mockResolvedValue(googleResponse({
          candidates: [{
            finishReason: 'STOP',
            content: { role: 'model', parts: [{ functionCall: { id: 'x', name: 'search_docs', args: {} }, thoughtSignature: 'sig' }] },
          }],
        })),
      },
    });
    await expect(executeReadOnlyToolLoop(invalidProvider, request(GOOGLE_ROUTER_MODEL), [{
      definition: {
        name: 'search_docs',
        description: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      replaySafety: 'pure_local',
      handler: invalidHandler,
    }], { authorizeToolExecution: allowPureLocalTool })).rejects.toEqual(new ReadOnlyToolLoopBoundaryError('tool_input_invalid'));
    expect(invalidHandler).not.toHaveBeenCalled();
  });

  it('rejects a missing Gemini thought signature before tool execution', async () => {
    const generateContent = vi.fn().mockResolvedValue(googleResponse({
      candidates: [{
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'x', name: 'search_docs', args: { query: 'stable' } } }],
        },
      }],
    }));
    const handler = vi.fn();
    const provider = new GoogleGenerateContentProvider('unused', { models: { generateContent } });

    await expect(executeReadOnlyToolLoop(provider, request(GOOGLE_ROUTER_MODEL), [{
      definition: {
        name: 'search_docs',
        description: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      replaySafety: 'pure_local',
      handler,
    }], { authorizeToolExecution: allowPureLocalTool })).rejects.toThrow('missing its thought signature');
    expect(generateContent).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects non-model Gemini candidates before tool execution', async () => {
    for (const role of ['user', undefined]) {
      const generateContent = vi.fn().mockResolvedValue(googleResponse({
        candidates: [{
          finishReason: 'STOP',
          content: {
            ...(role !== undefined && { role }),
            parts: [{
              functionCall: { id: 'x', name: 'search_docs', args: { query: 'stable' } },
              thoughtSignature: 'sig',
            }],
          },
        }],
      }));
      const handler = vi.fn();
      const provider = new GoogleGenerateContentProvider('unused', { models: { generateContent } });

      await expect(executeReadOnlyToolLoop(provider, request(GOOGLE_ROUTER_MODEL), [{
        definition: {
          name: 'search_docs',
          description: 'search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        replaySafety: 'pure_local',
        handler,
      }], { authorizeToolExecution: allowPureLocalTool })).rejects.toThrow('Malformed Google response role');
      expect(generateContent).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('rejects forged or mismatched Gemini continuation state', () => {
    const provider = new GoogleGenerateContentProvider('unused', {} as GoogleGenerateContentTransport);
    const definition = {
      name: 'search_docs',
      description: 'Search docs.',
      inputSchema: { type: 'object' },
    };
    expect(() => provider.prepare(request(GOOGLE_ROUTER_MODEL, {
      tools: [definition],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'call_1', name: 'search_docs', input: {} }],
        },
      ],
    }))).toThrow('was not issued by this adapter');

    const issuedCall = normalizeGoogleResponse(googleResponse({
      candidates: [{
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'call_1', name: 'search_docs', args: {} }, thoughtSignature: 'sig' }],
        },
      }],
    })).content[0];
    expect(() => provider.prepare(request(GOOGLE_ROUTER_MODEL, {
      tools: [definition],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [issuedCall] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            toolCallId: 'call_1',
            toolName: 'get_doc',
            content: 'wrong result',
          }],
        },
      ],
    }))).toThrow('does not match its call');
  });

  it('does not dispatch when the invocation policy rejects the request', async () => {
    const generateContent = vi.fn();
    const provider = new GoogleGenerateContentProvider('unused', { models: { generateContent } });
    await expect(executeReadOnlyToolLoop(provider, request(GOOGLE_ROUTER_MODEL), [{
      definition: { name: 'search_docs', description: 'search', inputSchema: { type: 'object' } },
      replaySafety: 'pure_local',
      handler: vi.fn(),
    }], {
      authorizeToolExecution: allowPureLocalTool,
      beforeDispatch: () => { throw new Error('policy_rejected'); },
    })).rejects.toThrow('policy_rejected');
    expect(generateContent).not.toHaveBeenCalled();
  });
});
