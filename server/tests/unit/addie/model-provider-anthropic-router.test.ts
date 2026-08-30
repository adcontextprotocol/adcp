import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_ROUTER_CAPABILITIES,
  AnthropicRouterProvider,
  type AnthropicRouterMessagesTransport,
} from '../../../src/addie/model-providers/anthropic-router-provider.js';
import { collectModelResponse } from '../../../src/addie/model-providers/events.js';
import {
  UnexpectedModelIdentityError,
  type ModelRequest,
} from '../../../src/addie/model-providers/model-provider.js';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-haiku-4-5',
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'route this' }] }],
    tools: [],
    maxOutputTokens: 300,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_router_1',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: '{"action":"ignore","reason":"test"}' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 2,
    },
    ...overrides,
  };
}

function providerWith(
  create: AnthropicRouterMessagesTransport['messages']['create'],
  maxRetries: 0 | 2 = 0,
): AnthropicRouterProvider {
  return new AnthropicRouterProvider('unused', {
    maxRetries,
    transport: { messages: { create } },
  });
}

describe('AnthropicRouterProvider request preparation', () => {
  it('requires an explicit supported retry budget at runtime', () => {
    expect(() => new AnthropicRouterProvider('unused', {
      maxRetries: 1,
      transport: { messages: { create: vi.fn() } },
    } as never)).toThrow('maxRetries must be 0 or 2');
  });

  it('builds and deeply freezes the exact historical stable Messages envelope', () => {
    const metadata = { trace: 'router-1', attempt: 1 };
    const modelRequest = request({ requestMetadata: metadata });
    const provider = providerWith(vi.fn());
    const prepared = provider.prepare(modelRequest);

    expect(prepared).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      capabilities: ANTHROPIC_ROUTER_CAPABILITIES,
      requestMetadata: metadata,
      providerRequest: {
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: 'route this' }],
      },
    });
    expect(prepared.providerRequest).not.toHaveProperty('system');
    expect(prepared.providerRequest).not.toHaveProperty('tools');
    expect(prepared.providerRequest).not.toHaveProperty('betas');
    expect(prepared.providerRequest).not.toHaveProperty('requestMetadata');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.providerRequest)).toBe(true);
    expect(Object.isFrozen(prepared.providerRequest.messages)).toBe(true);
    expect(Object.isFrozen((prepared.providerRequest.messages as object[])[0])).toBe(true);
    expect(Object.isFrozen(prepared.requestMetadata)).toBe(true);

    metadata.trace = 'changed';
    const text = modelRequest.messages[0].content[0];
    if (text.type === 'text') text.text = 'changed';
    expect(prepared.requestMetadata).toEqual({ trace: 'router-1', attempt: 1 });
    expect(prepared.providerRequest.messages).toEqual([
      { role: 'user', content: 'route this' },
    ]);
  });

  it.each([
    ['system blocks', { system: [{ text: 'system' }] }],
    ['custom tools', { tools: [{ name: 'search', description: 'search', inputSchema: {} }] }],
    ['provider tools', { providerTools: [{ type: 'web_search' as const }] }],
    ['structured output', { outputSchema: { name: 'route', schema: { type: 'object' } } }],
    ['reasoning', { reasoning: { effort: 'none' as const } }],
    ['multiple messages', {
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'one' }] },
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'two' }] },
      ],
    }],
    ['assistant messages', {
      messages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'one' }] }],
    }],
    ['multiple content blocks', {
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'one' },
          { type: 'text' as const, text: 'two' },
        ],
      }],
    }],
    ['image input', {
      messages: [{
        role: 'user' as const,
        content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'eA==' }],
      }],
    }],
    ['blank model', { model: ' ' }],
    ['invalid output bound', { maxOutputTokens: 0 }],
  ] as const)('fails closed on %s', (_label, overrides) => {
    const provider = providerWith(vi.fn());
    expect(() => provider.prepare(request(overrides as Partial<ModelRequest>))).toThrow();
  });
});

describe('AnthropicRouterProvider dispatch and normalization', () => {
  it('uses the stable transport with two production retries and the exact frozen callback snapshot', async () => {
    const order: string[] = [];
    let callbackRequest: Readonly<Record<string, unknown>> | undefined;
    const create = vi.fn(async (providerRequest: Record<string, unknown>) => {
      order.push('dispatch');
      expect(providerRequest).toBe(callbackRequest);
      return response({ model: 'claude-haiku-4-5-20251001' });
    });
    const provider = providerWith(create, 2);
    const modelRequest = request();
    const normalized = await collectModelResponse(provider.respond(modelRequest, {
      beforeDispatch: (prepared) => {
        order.push('before');
        callbackRequest = prepared.providerRequest;
        expect(prepared).toEqual(provider.prepare(modelRequest));
        expect(Reflect.set(prepared.providerRequest, 'model', 'changed')).toBe(false);
      },
    }), 'anthropic');

    expect(order).toEqual(['before', 'dispatch']);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 2 });
    expect(normalized).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        cacheWriteTokens: 3,
        cacheReadTokens: 2,
      },
    });
    expect(normalized.content).toEqual([
      { type: 'text', text: '{"action":"ignore","reason":"test"}' },
    ]);
  });

  it('uses zero retries for evaluation and forwards only transport options outside the envelope', async () => {
    const create = vi.fn(async () => response());
    const provider = providerWith(create, 0);
    const controller = new AbortController();

    await collectModelResponse(provider.respond(request(), { signal: controller.signal }));

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[1]).toEqual({
      maxRetries: 0,
      signal: controller.signal,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('maxRetries');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('signal');
  });

  it('accepts real SDK usage with nullable cache token fields', async () => {
    const create = vi.fn(async () => response({
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    }));

    const normalized = await collectModelResponse(providerWith(create).respond(request()));

    expect(normalized.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it('does not dispatch when the beforeDispatch guard rejects', async () => {
    const create = vi.fn(async () => response());
    const provider = providerWith(create, 2);

    await expect(collectModelResponse(provider.respond(request(), {
      beforeDispatch: () => {
        throw new Error('blocked');
      },
    }))).rejects.toThrow('blocked');
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves ordered text blocks and categorical finish reasons', async () => {
    const create = vi.fn(async () => response({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      stop_reason: 'max_tokens',
    }));
    const normalized = await collectModelResponse(providerWith(create).respond(request()));

    expect(normalized.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    expect(normalized.finishReason).toBe('length');
  });

  it('rejects an unexpected actual model identity', async () => {
    const create = vi.fn(async () => response({ model: 'claude-opus-5' }));
    await expect(collectModelResponse(providerWith(create).respond(request())))
      .rejects.toBeInstanceOf(UnexpectedModelIdentityError);
  });

  it('does not echo an unknown provider stop reason in the error', async () => {
    const create = vi.fn(async () => response({ stop_reason: 'private-sentinel' }));
    const error = await collectModelResponse(providerWith(create).respond(request()))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Unsupported Anthropic router stop reason');
    expect((error as Error).message).not.toContain('private-sentinel');
  });

  it.each([
    ['empty content', { content: [] }],
    ['non-text content', { content: [{ type: 'tool_use', id: 'tool_1', name: 'search', input: {} }] }],
    ['missing stop reason', { stop_reason: null }],
    ['unknown stop reason', { stop_reason: 'future_reason' }],
    ['missing usage', { usage: undefined }],
    ['invalid input usage', { usage: { input_tokens: -1, output_tokens: 1 } }],
    ['invalid output usage', { usage: { input_tokens: 1, output_tokens: 1.5 } }],
    ['blank response ID', { id: '' }],
  ])('fails closed on %s', async (_label, overrides) => {
    const create = vi.fn(async () => response(overrides));
    await expect(collectModelResponse(providerWith(create).respond(request()))).rejects.toThrow();
  });
});
