import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicModelProvider,
  normalizeAnthropicResponse,
  type AnthropicMessagesTransport,
} from '../../../src/addie/model-providers/anthropic-provider.js';
import { validateModelCapabilities } from '../../../src/addie/model-providers/capabilities.js';
import {
  collectModelResponse,
  createProviderToolCorrelationState,
  InvalidModelEventStreamError,
  validateNormalizedModelResponse,
} from '../../../src/addie/model-providers/events.js';
import {
  classifyLocalModelExecution,
  UnsupportedModelCapabilityError,
  type ModelProviderCapabilities,
  type ModelRequest,
  type ModelResponse,
  type NormalizedModelEvent,
} from '../../../src/addie/model-providers/model-provider.js';
import { AddieClaudeClient } from '../../../src/addie/claude-client.js';

describe('model execution selection integrity', () => {
  it('rejects a partially populated requested provider/model tuple', () => {
    expect(() => classifyLocalModelExecution(
      { requested_provider: 'openai', requested_model: null } as never,
      'provider_error',
    )).toThrow('Requested provider and model must be supplied together');
  });
});

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-test',
    system: [{ text: 'system', cacheHint: 'ephemeral' }, { text: 'context' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    maxOutputTokens: 8192,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    model: 'claude-test',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
    },
    ...overrides,
  };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

describe('AnthropicModelProvider request translation', () => {
  it('builds the exact Anthropic envelope from canonical messages and tools', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const serverContinuation = normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: [{
        type: 'server_tool_use',
        id: 'server_1',
        name: 'web_search',
        input: { query: 'AdCP' },
      }],
    })).content[0];
    const prepared = provider.prepare(request({
      providerTools: [{ type: 'web_search' }],
      tools: [{
        name: 'search_docs',
        description: 'Search public docs',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        cacheHint: 'ephemeral',
      }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
            { type: 'document', mediaType: 'application/pdf', data: 'cGRm' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_call', id: 'tool_1', name: 'search_docs', input: { query: '3.2' } },
          ],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            toolCallId: 'tool_1',
            content: 'result',
            isError: false,
          }],
        },
        {
          role: 'assistant',
          content: [serverContinuation],
        },
      ],
    }));

    expect(prepared.provider).toBe('anthropic');
    expect(prepared.providerRequest).toEqual({
      model: 'claude-test',
      max_tokens: 8192,
      system: [
        { type: 'text', text: 'system', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'context' },
      ],
      tools: [
        {
          name: 'search_docs',
          description: 'Search public docs',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          cache_control: { type: 'ephemeral' },
        },
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: '3.2' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'result', is_error: false }],
        },
        {
          role: 'assistant',
          content: [{ type: 'server_tool_use', id: 'server_1', name: 'web_search', input: { query: 'AdCP' } }],
        },
      ],
      betas: ['web-search-2025-03-05'],
    });
  });

  it('rejects continuation state from a different provider', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(() => provider.prepare(request({
      messages: [{
        role: 'assistant',
        content: [{ type: 'provider_state', provider: 'google', kind: 'thought' }],
      }],
    }))).toThrow('Cannot send google continuation state to Anthropic');
  });

  it('rejects forged same-provider continuation state', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(() => provider.prepare(request({
      messages: [{
        role: 'assistant',
        content: [{ type: 'provider_state', provider: 'anthropic', kind: 'thinking' }],
      }],
    }))).toThrow('was not issued by this adapter');
  });

  it('preserves production string turns and merges adjacent roles', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const prepared = provider.prepare(request({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'three' }] },
      ],
    }));
    expect(prepared.providerRequest.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
      },
      { role: 'assistant', content: 'three' },
    ]);
  });

  it('matches the existing signed Anthropic envelope for a simple turn', () => {
    const existing = new AddieClaudeClient('unused', 'claude-test');
    existing.setWebSearchEnabled(false);
    const existingSnapshot = existing.prepareMessageInvocation(
      'hello',
      undefined,
      undefined,
      { systemPrompt: 'system' },
      { executionMode: 'production', disableServerTools: true },
    );
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const canonical = provider.prepare(request({
      system: [{ text: 'system', cacheHint: 'ephemeral' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }));
    expect(sha256(canonical.providerRequest)).toBe(existingSnapshot.provider_request_sha256);
  });

  it('matches the existing signed envelope for cached custom tools and web search', () => {
    const definition = {
      name: 'search_docs',
      description: 'Search docs',
      input_schema: {
        type: 'object' as const,
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    };
    const existing = new AddieClaudeClient('unused', 'claude-test');
    existing.registerTool(definition, async () => 'unused');
    const existingSnapshot = existing.prepareMessageInvocation(
      'hello',
      undefined,
      undefined,
      { systemPrompt: 'system' },
      { executionMode: 'production' },
    );
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const canonical = provider.prepare(request({
      system: [{ text: 'system', cacheHint: 'ephemeral' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{
        name: definition.name,
        description: definition.description,
        inputSchema: definition.input_schema,
        cacheHint: 'ephemeral',
      }],
      providerTools: [{ type: 'web_search' }],
    }));
    expect(sha256(canonical.providerRequest)).toBe(existingSnapshot.provider_request_sha256);
  });

  it('matches the existing signed envelope for current-turn attachments', () => {
    const existing = new AddieClaudeClient('unused', 'claude-test');
    existing.setWebSearchEnabled(false);
    const existingSnapshot = existing.prepareMessageInvocation(
      'hello',
      undefined,
      undefined,
      { systemPrompt: 'system' },
      {
        executionMode: 'production',
        disableServerTools: true,
        inputAttachments: [{
          type: 'image',
          media_type: 'image/png',
          data: 'aW1hZ2U=',
          filename: 'diagram.png',
          size_bytes: 5,
        }],
      },
    );
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const canonical = provider.prepare(request({
      system: [{ text: 'system', cacheHint: 'ephemeral' }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
          { type: 'text', text: '[Uploaded image: diagram.png]' },
        ],
      }],
    }));
    expect(sha256(canonical.providerRequest)).toBe(existingSnapshot.provider_request_sha256);
  });

  it('preserves application metadata outside the provider envelope', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const prepared = provider.prepare(request({
      requestMetadata: { trace: 'trace-1', attempt: 1 },
    }));
    expect(prepared.requestMetadata).toEqual({ trace: 'trace-1', attempt: 1 });
    expect(prepared.providerRequest).not.toHaveProperty('requestMetadata');
    expect(prepared.providerRequest).not.toHaveProperty('metadata');
  });

  it('maps canonical medium reasoning to the Sonnet output control envelope', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(provider.prepare(request({ reasoning: { effort: 'medium' } })).providerRequest)
      .toMatchObject({ output_config: { effort: 'medium' } });
  });

  it('preserves issued text blocks as arrays for same-provider continuation', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const continuation = normalizeAnthropicResponse(response({
      stop_reason: 'pause_turn',
      content: [{ type: 'text', text: 'Server work is pending.' }],
    })).content;

    expect(provider.prepare(request({
      messages: [{ role: 'assistant', content: continuation }],
    })).providerRequest.messages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'Server work is pending.' }],
    }]);
  });

  it('fails closed on structured output instead of silently dropping it', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(() => provider.prepare(request({
      outputSchema: { name: 'answer', schema: { type: 'object' }, strict: true },
    }))).toThrow(UnsupportedModelCapabilityError);
  });
});

describe('AnthropicModelProvider response normalization', () => {
  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['refusal', 'refusal'],
    ['pause_turn', 'continue'],
    ['compaction', 'continue'],
  ] as const)('maps %s to %s', (providerReason, normalizedReason) => {
    const content = providerReason === 'tool_use'
      ? [{ type: 'tool_use', id: 'tool_1', name: 'search_docs', input: {} }]
      : [{ type: 'text', text: 'done' }];
    expect(normalizeAnthropicResponse(response({ stop_reason: providerReason, content })).finishReason)
      .toBe(normalizedReason);
  });

  it.each([
    request({ model: ' ' }),
    request({ maxOutputTokens: 0 }),
    request({ maxOutputTokens: 1.5 }),
    request({
      tools: [
        { name: 'duplicate', description: 'one', inputSchema: {} },
        { name: 'duplicate', description: 'two', inputSchema: {} },
      ],
    }),
  ])('rejects an invalid canonical request before provider translation', (modelRequest) => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(() => provider.prepare(modelRequest)).toThrow();
  });

  it('normalizes tool calls, redacted provider receipts, and cache usage', () => {
    const normalized = normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'before' },
        { type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'x' } },
        { type: 'server_tool_use', id: 'server_1', name: 'web_search', input: { query: 'y' } },
        { type: 'web_search_tool_result', tool_use_id: 'server_1', content: [] },
      ],
    }));

    expect(normalized).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test',
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
      usage: { inputTokens: 11, outputTokens: 7, cacheWriteTokens: 5, cacheReadTokens: 3 },
    });
    expect(normalized.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'tool_call', id: 'tool_1', name: 'search_docs', input: { query: 'x' } },
      {
        type: 'provider_tool_call',
        provider: 'anthropic',
        id: 'server_1',
        name: 'web_search',
        inputKeys: ['query'],
      },
      {
        type: 'provider_tool_result',
        provider: 'anthropic',
        toolCallId: 'server_1',
        name: 'web_search',
        resultCount: 0,
        isError: false,
      },
    ]);
    expect(JSON.stringify(normalized)).not.toContain('query":"y');
  });

  it.each([
    response({ stop_reason: null }),
    response({ stop_reason: 'future_reason' }),
    response({ content: [{ type: 'future_block' }] }),
    response({ content: [{ type: 'tool_use', id: 'x', name: 'bad', input: [] }] }),
    response({ id: '' }),
    response({ model: '' }),
    response({ usage: undefined }),
    response({ usage: { input_tokens: -1, output_tokens: 1 } }),
    response({ usage: { input_tokens: 1.5, output_tokens: 1 } }),
  ])('rejects malformed or unknown provider output', (fixture) => {
    expect(() => normalizeAnthropicResponse(fixture)).toThrow();
  });

  it('dispatches once with SDK retries disabled and exposes the exact request before dispatch', async () => {
    const order: string[] = [];
    const create = vi.fn(async () => {
      order.push('dispatch');
      return response();
    });
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    });
    const events: NormalizedModelEvent[] = [];
    const modelRequest = request();
    for await (const event of provider.respond(modelRequest, {
      beforeDispatch: (prepared) => {
        order.push('before');
        expect(prepared.providerRequest).toEqual(provider.prepare(modelRequest).providerRequest);
      },
    })) {
      events.push(event);
    }

    expect(order).toEqual(['before', 'dispatch']);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
    expect(events.map((event) => event.type)).toEqual([
      'response_start',
      'text_delta',
      'response_complete',
    ]);
    await expect(collectModelResponse((async function* () { yield* events; })(), 'anthropic'))
      .resolves.toMatchObject({ finishReason: 'stop' });
  });

  it('allows the production caller to preserve two SDK transport retries', async () => {
    const create = vi.fn(async () => response());
    const provider = new AnthropicModelProvider(
      'unused',
      { beta: { messages: { create } } },
      { transportMaxRetries: 2 },
    );

    for await (const _event of provider.respond(request())) {
      // Drain the response.
    }

    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 2 });
  });

  it('uses the streaming transport while preserving normalized chunk boundaries', async () => {
    const create = vi.fn();
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'do' },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ne' },
        };
      },
      finalMessage: vi.fn(async () => response()),
    }));
    const provider = new AnthropicModelProvider(
      'unused',
      { beta: { messages: { create, stream } } },
      { transportMaxRetries: 2 },
    );

    const events: NormalizedModelEvent[] = [];
    for await (const event of provider.respond(request(), { stream: true })) events.push(event);
    const normalized = await collectModelResponse((async function* () { yield* events; })());

    expect(normalized.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', index: 0, text: 'do' },
      { type: 'text_delta', index: 0, text: 'ne' },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledWith(
      provider.prepare(request()).providerRequest,
      { maxRetries: 2 },
    );
  });

  it('rejects streamed text that disagrees with the terminal response', async () => {
    const provider = new AnthropicModelProvider('unused', {
      beta: {
        messages: {
          create: vi.fn(),
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'different' },
              };
            },
            finalMessage: vi.fn(async () => response()),
          })),
        },
      },
    });

    await expect(collectModelResponse(provider.respond(request(), { stream: true })))
      .rejects.toThrow('Anthropic stream text does not match terminal response');
  });

  it('fails closed when a transport cannot provide streaming', async () => {
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create: vi.fn() } },
    });

    await expect(collectModelResponse(provider.respond(request(), { stream: true })))
      .rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
  });

  it('freezes the exact nested envelope before provenance and dispatch', async () => {
    let dispatched: Record<string, unknown> | undefined;
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create: vi.fn(async (payload) => {
        dispatched = payload;
        return response();
      }) } },
    });
    const modelRequest = request({
      tools: [{ name: 'safe', description: 'safe', inputSchema: { type: 'object' } }],
    });
    for await (const _event of provider.respond(modelRequest, {
      beforeDispatch: (prepared) => {
        const mutable = prepared.providerRequest as Record<string, unknown>;
        expect(Reflect.set(mutable, 'model', 'changed')).toBe(false);
        const tools = mutable.tools as Array<Record<string, unknown>>;
        expect(Reflect.set(tools[0], 'name', 'changed')).toBe(false);
      },
    })) {
      // Drain the response.
    }
    expect(dispatched?.model).toBe('claude-test');
    expect((dispatched?.tools as Array<Record<string, unknown>>)[0].name).toBe('safe');
  });

  it('keeps thinking and web result bytes out of serializable normalized events', () => {
    const secret = 'PRIVATE_SENTINEL';
    const normalized = normalizeAnthropicResponse(response({
      stop_reason: 'pause_turn',
      content: [
        { type: 'thinking', thinking: secret, signature: `sig-${secret}` },
        { type: 'server_tool_use', id: 'server_1', name: 'web_search', input: { query: secret } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'server_1',
          content: [{ type: 'web_search_result', title: secret, url: 'https://example.com' }],
        },
      ],
    }));
    expect(JSON.stringify(normalized)).not.toContain(secret);
    expect(normalized.content).toEqual([
      { type: 'provider_state', provider: 'anthropic', kind: 'thinking' },
      {
        type: 'provider_tool_call',
        provider: 'anthropic',
        id: 'server_1',
        name: 'web_search',
        inputKeys: ['query'],
      },
      {
        type: 'provider_tool_result',
        provider: 'anthropic',
        toolCallId: 'server_1',
        name: 'web_search',
        resultCount: 1,
        isError: false,
      },
    ]);
  });

  it('round-trips exact private continuation blocks without serializing them publicly', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const rawBlocks = [
      { type: 'text', text: 'cited', citations: [{ type: 'web_search_result_location', url: 'https://example.com' }] },
      { type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'x' }, caller: { type: 'direct' } },
      { type: 'thinking', thinking: 'private reasoning', signature: 'signature' },
      { type: 'server_tool_use', id: 'server_1', name: 'web_search', input: { query: 'private query' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'server_1',
        content: [{
          type: 'web_search_result',
          encrypted_content: 'ciphertext',
          page_age: null,
          title: 'Result',
          url: 'https://example.com',
        }],
      },
    ];
    const normalized = normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: rawBlocks,
    }));
    const continuationRequest = request({
      messages: [{ role: 'assistant', content: normalized.content }],
    });
    const prepared = provider.prepare(continuationRequest);
    expect(prepared.providerRequest.messages).toEqual([
      { role: 'assistant', content: rawBlocks },
    ]);
    const expected = {
      model: 'claude-test',
      max_tokens: 8192,
      system: [
        { type: 'text', text: 'system', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'context' },
      ],
      tools: [],
      messages: [{ role: 'assistant', content: rawBlocks }],
      betas: ['web-search-2025-03-05'],
    };
    expect(sha256(prepared.providerRequest)).toBe(sha256(expected));
    expect(JSON.stringify(normalized)).not.toContain('private reasoning');
    expect(JSON.stringify(normalized)).not.toContain('private query');
  });

  it('freezes public provider receipts and derives details only under explicit disclosure', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const normalized = normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: [
        { type: 'server_tool_use', id: 'server_1', name: 'web_search', input: { query: 'private query' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'server_1',
          content: [{
            type: 'web_search_result',
            encrypted_content: 'ciphertext',
            page_age: null,
            title: 'Private title',
            url: 'https://example.com/private',
          }],
        },
      ],
    }));
    const call = normalized.content[0];
    const result = normalized.content[1];
    expect(call.type).toBe('provider_tool_call');
    expect(result.type).toBe('provider_tool_result');
    if (call.type !== 'provider_tool_call' || result.type !== 'provider_tool_result') return;
    expect(Reflect.set(call, 'id', 'changed')).toBe(false);
    expect(Reflect.set(result, 'resultCount', 999)).toBe(false);
    const redacted = provider.deriveProviderToolReceipt(call, result, 'redacted');
    const production = provider.deriveProviderToolReceipt(call, result, 'production');
    expect(JSON.stringify(redacted)).not.toContain('private');
    expect(production).toMatchObject({
      parameters: { query: 'private query' },
      resultSummary: 'Web search completed (1 results)',
    });
    expect(production.resultDetails).toContain('Private title: https://example.com/private');
  });

  it('does not expose malformed provider-controlled receipt categories', () => {
    const sentinel = 'PRIVATE_SENTINEL';
    const normalized = normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: [{
        type: 'server_tool_use',
        id: 'server_1',
        name: 'web_search',
        input: { query: 'safe', [sentinel]: 'value' },
      }],
    }));
    expect(JSON.stringify(normalized)).not.toContain(sentinel);
    expect(() => normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: [
        { type: 'server_tool_use', id: 'server_1', name: 'web_search', input: { query: 'safe' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'server_1',
          content: { type: 'web_search_tool_result_error', error_code: sentinel },
        },
      ],
    }))).toThrow('Malformed Anthropic web_search_tool_result block');
  });

  it('rejects oversized private continuation state', () => {
    expect(() => normalizeAnthropicResponse(response({
      stop_reason: 'pause_turn',
      content: [{
        type: 'thinking',
        thinking: 'x'.repeat(2 * 1024 * 1024),
        signature: 'signature',
      }],
    }))).toThrow('exceeds size limit');
  });

  it('rejects a malformed transport response before emitting normalized events', async () => {
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create: vi.fn(async () => response({ usage: undefined })) } },
    });
    await expect(collectModelResponse(provider.respond(request()), 'anthropic'))
      .rejects.toThrow('Malformed Anthropic response usage');
  });

  it('rejects incoherent finish reasons', () => {
    expect(() => normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'no call' }],
    }))).toThrow('Tool-call finish has no tool call');
    expect(() => normalizeAnthropicResponse(response({
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 'tool_1', name: 'search_docs', input: {} }],
    }))).toThrow('incompatible finish reason');
  });

  it('supports Anthropic server results deferred across a mixed client-tool turn', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    const first = normalizeAnthropicResponse(response({
      stop_reason: 'tool_use',
      content: [
        { type: 'server_tool_use', id: 'server_1', name: 'web_search', input: { query: 'AdCP' } },
        { type: 'tool_use', id: 'client_1', name: 'search_docs', input: { query: 'AdCP' } },
      ],
    }));
    const second = normalizeAnthropicResponse(response({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'server_1',
          content: [{
            type: 'web_search_result',
            encrypted_content: 'ciphertext',
            page_age: null,
            title: 'AdCP',
            url: 'https://example.com',
          }],
        },
        { type: 'text', text: 'done' },
      ],
    }));
    const state = createProviderToolCorrelationState();
    expect(() => validateNormalizedModelResponse(first, state)).not.toThrow();
    expect(state.pending.has('server_1')).toBe(true);
    expect(() => validateNormalizedModelResponse(second, state)).not.toThrow();
    expect(state.pending.size).toBe(0);
    const call = first.content.find((content) => content.type === 'provider_tool_call');
    const result = second.content.find((content) => content.type === 'provider_tool_result');
    expect(call).toBeDefined();
    expect(result).toBeDefined();
    if (call?.type !== 'provider_tool_call' || result?.type !== 'provider_tool_result') return;
    expect(provider.deriveProviderToolReceipt(call, result, 'production').resultDetails)
      .toContain('AdCP: https://example.com');
  });
});

describe('provider-neutral capability and event guards', () => {
  const noCapabilities: ModelProviderCapabilities = {
    streaming: false,
    structuredOutput: false,
    reasoning: false,
    reasoningEfforts: [],
    customTools: false,
    providerWebSearch: false,
    imageInput: false,
    documentInput: false,
  };

  it.each([
    [request(), { streaming: true }, 'streaming'],
    [request({ tools: [{ name: 'x', description: 'x', inputSchema: {} }] }), {}, 'customTools'],
    [request({ providerTools: [{ type: 'web_search' }] }), {}, 'providerWebSearch'],
    [request({ reasoning: { effort: 'high' } }), {}, 'reasoning'],
    [request({ messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'x' }] }] }), {}, 'imageInput'],
    [request({ messages: [{ role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: 'x' }] }] }), {}, 'documentInput'],
  ] as const)('rejects a missing %s capability', (modelRequest, requirements, capability) => {
    expect(() => validateModelCapabilities('google', noCapabilities, modelRequest, requirements))
      .toThrow(expect.objectContaining({ capability }));
  });

  it('rejects duplicate or colliding provider tool namespaces', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(() => provider.prepare(request({
      providerTools: [{ type: 'web_search' }, { type: 'web_search' }],
    }))).toThrow('Duplicate provider tool');
    expect(() => provider.prepare(request({
      tools: [{ name: 'web_search', description: 'collision', inputSchema: {} }],
      providerTools: [{ type: 'web_search' }],
    }))).toThrow('collides with provider tool');
  });

  it('rejects non-JSON schemas and tool inputs before translation', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(() => provider.prepare(request({
      tools: [{
        name: 'bad_schema',
        description: 'bad',
        inputSchema: { generatedAt: new Date() } as never,
      }],
    }))).toThrow('plain JSON objects');
    expect(() => provider.prepare(request({
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_call',
          id: 'bad',
          name: 'bad_input',
          input: { value: Number.NaN },
        }],
      }],
    }))).toThrow('finite JSON numbers');
    const allCapabilities: ModelProviderCapabilities = {
      streaming: true,
      structuredOutput: true,
      reasoning: true,
      reasoningEfforts: ['provider_default', 'none', 'low', 'medium', 'high'],
      customTools: true,
      providerWebSearch: true,
      imageInput: true,
      documentInput: true,
    };
    expect(() => validateModelCapabilities('openai', allCapabilities, request({
      outputSchema: {
        name: 'bad_output',
        schema: { generatedAt: new Date() } as never,
      },
    }))).toThrow('plain JSON objects');
  });

  it('does not silently ignore a request to disable reasoning', () => {
    const provider = new AnthropicModelProvider('unused', {} as AnthropicMessagesTransport);
    expect(() => provider.prepare(request({ reasoning: { effort: 'none' } })))
      .toThrow(UnsupportedModelCapabilityError);
  });

  it('rejects incomplete, duplicate, post-terminal, and invalid-usage streams', async () => {
    const stream = (events: NormalizedModelEvent[]) => (async function* () { yield* events; })();
    const start: NormalizedModelEvent = { type: 'response_start', provider: 'anthropic', model: 'm' };
    const complete: NormalizedModelEvent = {
      type: 'response_complete',
      response: {
        provider: 'anthropic',
        model: 'm',
        id: 'id',
        content: [],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    };

    await expect(collectModelResponse(stream([]))).rejects.toBeInstanceOf(InvalidModelEventStreamError);
    await expect(collectModelResponse(stream([start]))).rejects.toThrow('Missing normalized response_complete');
    await expect(collectModelResponse(stream([start, start]))).rejects.toThrow('Duplicate');
    await expect(collectModelResponse(stream([start, complete, { type: 'text_delta', index: 0, text: 'late' }]))).rejects.toThrow('after terminal');
    await expect(collectModelResponse(stream([
      start,
      {
        ...complete,
        response: { ...complete.response, usage: { inputTokens: -1, outputTokens: 1 } },
      },
    ]))).rejects.toThrow('Invalid normalized usage');
    await expect(collectModelResponse(stream([
      start,
      { type: 'text_delta', index: 0, text: 'different' },
      {
        ...complete,
        response: { ...complete.response, content: [{ type: 'text', text: 'terminal' }] },
      },
    ]))).rejects.toThrow('do not match terminal content');
  });

  it('requires streamed tool deltas to match a complete terminal tool call', async () => {
    const stream = (events: NormalizedModelEvent[]) => (async function* () { yield* events; })();
    const start: NormalizedModelEvent = { type: 'response_start', provider: 'anthropic', model: 'm', id: 'id' };
    const call = { type: 'tool_call' as const, id: 'tool_1', name: 'search_docs', input: { query: 'x' } };
    const complete: NormalizedModelEvent = {
      type: 'response_complete',
      response: {
        provider: 'anthropic',
        model: 'm',
        id: 'id',
        content: [call],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    };
    await expect(collectModelResponse(stream([
      start,
      { type: 'tool_call_delta', index: 0, id: 'tool_1', name: 'search_docs', inputJsonDelta: '{"query":' },
      { type: 'tool_call_delta', index: 0, inputJsonDelta: '"x"}' },
      { type: 'tool_call', index: 0, call },
      complete,
    ]))).resolves.toMatchObject({ finishReason: 'tool_calls' });
    await expect(collectModelResponse(stream([
      start,
      { type: 'tool_call_delta', index: 0, id: 'orphan' },
      {
        ...complete,
        response: { ...complete.response, content: [] },
      },
    ]))).rejects.toThrow('missing a completed tool call');
    await expect(collectModelResponse(stream([
      start,
      { type: 'tool_call_delta', index: 0, id: 'different', inputJsonDelta: '{"query":"x"}' },
      { type: 'tool_call', index: 0, call },
      complete,
    ]))).rejects.toThrow('ID does not match');
  });

  it('enforces one-to-one provider call/result linkage when both are present', () => {
    const base: ModelResponse = {
      provider: 'anthropic',
      model: 'm',
      id: 'id',
      content: [
        {
          type: 'provider_tool_call',
          provider: 'anthropic',
          id: 'server_1',
          name: 'web_search',
          inputKeys: ['query'],
        },
        {
          type: 'provider_tool_result',
          provider: 'anthropic',
          toolCallId: 'server_1',
          name: 'web_search',
          resultCount: 1,
          isError: false,
        },
      ],
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    expect(() => validateNormalizedModelResponse({
      ...base,
      content: [...base.content, base.content[1]],
    })).toThrow('Duplicate provider tool result ID');
    expect(() => validateNormalizedModelResponse({
      ...base,
      content: [
        base.content[0],
        { ...base.content[1], name: 'different' } as ModelResponse['content'][number],
      ],
    })).toThrow('does not match its call');
  });

  it('rolls back conversation correlation state when response validation fails', () => {
    const existing = createProviderToolCorrelationState();
    existing.pending.set('existing', { provider: 'anthropic', name: 'web_search' });
    const result = (id: string): ModelResponse['content'][number] => ({
      type: 'provider_tool_result',
      provider: 'anthropic',
      toolCallId: id,
      name: 'web_search',
      resultCount: 1,
      isError: false,
    });
    const invalidRemoval: ModelResponse = {
      provider: 'anthropic',
      model: 'm',
      id: 'id',
      content: [result('existing'), result('unknown')],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    expect(() => validateNormalizedModelResponse(invalidRemoval, existing))
      .toThrow('no pending call');
    expect([...existing.pending.keys()]).toEqual(['existing']);

    const empty = createProviderToolCorrelationState();
    const invalidAddition: ModelResponse = {
      ...invalidRemoval,
      content: [
        {
          type: 'provider_tool_call',
          provider: 'anthropic',
          id: 'new_call',
          name: 'web_search',
          inputKeys: ['query'],
        },
        result('unknown'),
      ],
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
    };
    expect(() => validateNormalizedModelResponse(invalidAddition, empty))
      .toThrow('no pending call');
    expect(empty.pending.size).toBe(0);
  });
});
