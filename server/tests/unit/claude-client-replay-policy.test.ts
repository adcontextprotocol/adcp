import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkState = vi.hoisted(() => ({
  nonStreamingResponses: [] as unknown[],
  streamingResponses: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Record<string, unknown>>,
  requestOptions: [] as unknown[],
}));

const loggerState = vi.hoisted(() => ({ entries: [] as unknown[][] }));

vi.mock('../../src/logger.js', () => {
  const record = (...args: unknown[]) => loggerState.entries.push(args);
  const logger = {
    trace: record,
    debug: record,
    info: record,
    warn: record,
    error: record,
    fatal: record,
    child: () => logger,
  };
  return { createLogger: () => logger, logger };
});

const notifyToolError = vi.hoisted(() => vi.fn());
const notifySystemError = vi.hoisted(() => vi.fn());

vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError,
  notifyToolError,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  APIError: class APIError extends Error {},
  APIConnectionError: class APIConnectionError extends Error {},
  default: class {
    beta = {
      messages: {
        create: vi.fn(async (payload: Record<string, unknown>, options?: unknown) => {
          sdkState.calls.push(payload);
          sdkState.requestOptions.push(options);
          const response = sdkState.nonStreamingResponses.shift();
          if (!response) throw new Error('Missing non-streaming response fixture');
          if (response instanceof Error) throw response;
          return {
            id: `msg_test_${sdkState.calls.length}`,
            model: String(payload.model),
            ...response as Record<string, unknown>,
          };
        }),
        stream: vi.fn((payload: Record<string, unknown>) => {
          sdkState.calls.push(payload);
          const response = sdkState.streamingResponses.shift();
          if (!response) throw new Error('Missing streaming response fixture');
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn().mockResolvedValue({
              id: `msg_test_${sdkState.calls.length}`,
              model: String(payload.model),
              ...response,
            }),
          };
        }),
      },
    };
  },
}));

import {
  AddieClaudeClient,
  type InvocationPreparedSnapshot,
  type RequestTools,
  type StreamEvent,
} from '../../src/addie/claude-client.js';
import type { AddieTool } from '../../src/addie/types.js';

const usage = { input_tokens: 3, output_tokens: 2 };

function toolUseResponse(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): Record<string, unknown> {
  return {
    stop_reason: 'tool_use',
    content: calls.map((call) => ({ type: 'tool_use', ...call })),
    usage,
  };
}

function textResponse(text = 'Done'): Record<string, unknown> {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage,
  };
}

function tool(name: string, replaySafety?: AddieTool['replaySafety']): AddieTool {
  return {
    name,
    description: `${name} description`,
    ...(replaySafety && { replaySafety }),
    input_schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
  };
}

function requestTools(
  definitions: AddieTool[],
  handlers: Array<[string, (input: Record<string, unknown>) => Promise<string>]>,
): RequestTools {
  return { tools: definitions, handlers: new Map(handlers) };
}

function invocationHmac(key: string, domain: string, value: string): string {
  return createHmac('sha256', key)
    .update('addie-invocation\0', 'utf8')
    .update(String(Buffer.byteLength(domain, 'utf8')), 'utf8')
    .update('\0', 'utf8')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

beforeEach(() => {
  sdkState.nonStreamingResponses.length = 0;
  sdkState.streamingResponses.length = 0;
  sdkState.calls.length = 0;
  sdkState.requestOptions.length = 0;
  loggerState.entries.length = 0;
  notifyToolError.mockReset();
  notifySystemError.mockReset();
});

describe('AddieClaudeClient replay execution policy', () => {
  it('blocks mutation and unclassified handlers while executing a pure local read once', async () => {
    const mutation = vi.fn().mockResolvedValue('mutated');
    const mixed = vi.fn().mockResolvedValue('mixed');
    const safeRead = vi.fn().mockResolvedValue('private raw read result');
    const tools = requestTools(
      [tool('mutate_record', 'mutation'), tool('mixed_tool'), tool('read_docs', 'pure_local')],
      [
        ['mutate_record', mutation],
        ['mixed_tool', mixed],
        ['read_docs', safeRead],
      ],
    );
    sdkState.nonStreamingResponses.push(
      toolUseResponse([
        { id: 'tool-1', name: 'mutate_record', input: { value: 'secret mutation' } },
        { id: 'tool-2', name: 'mixed_tool', input: { value: 'secret mixed' } },
        { id: 'tool-3', name: 'read_docs', input: { value: 'secret query' } },
      ]),
      textResponse(),
    );

    const client = new AddieClaudeClient('unused');
    const response = await client.processMessage(
      'evaluate this',
      undefined,
      tools,
      { systemPrompt: 'evaluation system' },
      {
        executionMode: 'replay',
        disableServerTools: true,
        toolExecutionPolicy: ({ toolName, tool: definition }) => {
          if (toolName === 'mixed_tool') throw new Error('policy lookup failed');
          return { allowed: definition?.replaySafety === 'pure_local' };
        },
      },
    );

    expect(mutation).not.toHaveBeenCalled();
    expect(mixed).not.toHaveBeenCalled();
    expect(safeRead).toHaveBeenCalledOnce();
    expect(safeRead).toHaveBeenCalledWith({ value: 'secret query' });
    expect(response.tool_executions).toHaveLength(3);
    expect(response.tool_executions.slice(0, 2)).toEqual([
      expect.objectContaining({
        tool_name: 'mutate_record',
        parameters: {},
        result: 'Error: Tool execution blocked by policy',
        duration_ms: 0,
        blocked_by_policy: true,
        is_error: true,
      }),
      expect.objectContaining({
        tool_name: 'mixed_tool',
        parameters: {},
        result: 'Error: Tool execution blocked by policy',
        duration_ms: 0,
        blocked_by_policy: true,
        is_error: true,
      }),
    ]);
    expect(response.tool_executions[2]).toMatchObject({
      tool_name: 'read_docs',
      parameters: {},
      result: 'Tool execution completed',
      result_summary: 'Tool execution completed',
      is_error: false,
    });
    expect(JSON.stringify(response.tool_executions)).not.toContain('secret');
    expect(JSON.stringify(response.tool_executions)).not.toContain('private raw read result');
  });

  it('applies the same fail-closed policy and redaction to streaming dispatch', async () => {
    const mixed = vi.fn().mockResolvedValue('must not run');
    sdkState.streamingResponses.push(
      toolUseResponse([{ id: 'stream-tool', name: 'mixed_tool', input: { value: 'stream secret' } }]),
      textResponse('Stream done'),
    );

    const client = new AddieClaudeClient('unused');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'evaluate stream',
      undefined,
      requestTools([tool('mixed_tool')], [['mixed_tool', mixed]]),
      {
        executionMode: 'evaluation',
        toolExecutionPolicy: () => ({ allowed: false }),
      },
    )) {
      events.push(event);
    }

    expect(mixed).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'tool_start')).toMatchObject({ parameters: {} });
    expect(events.find((event) => event.type === 'tool_end')).toMatchObject({
      result: 'Error: Tool execution blocked by policy',
      is_error: true,
    });
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.tool_executions[0]).toMatchObject({
      parameters: {},
      blocked_by_policy: true,
      duration_ms: 0,
    });
  });

  it('disables web search per request without mutating shared client state', async () => {
    sdkState.nonStreamingResponses.push(textResponse('disabled'), textResponse('enabled'), textResponse('default'));
    const client = new AddieClaudeClient('unused');

    await Promise.all([
      client.processMessage('disabled request', undefined, undefined, { systemPrompt: 'system' }, {
        executionMode: 'evaluation',
        disableServerTools: true,
      }),
      client.processMessage('enabled request', undefined, undefined, { systemPrompt: 'system' }, {
        executionMode: 'evaluation',
      }),
    ]);
    await client.processMessage('default request', undefined, undefined, { systemPrompt: 'system' }, {
      uncapped: true,
    });

    const hasWebSearch = (call: Record<string, unknown>) =>
      (call.tools as Array<{ name?: string }>).some((entry) => entry.name === 'web_search');
    const callFor = (message: string) => sdkState.calls.find((call) => JSON.stringify(call.messages).includes(message));
    expect(hasWebSearch(callFor('disabled request')!)).toBe(false);
    expect(hasWebSearch(callFor('enabled request')!)).toBe(false);
    expect(hasWebSearch(callFor('default request')!)).toBe(true);
  });

  it('blocks custom handlers when evaluation omits a policy', async () => {
    const handler = vi.fn().mockResolvedValue('must not execute');
    sdkState.nonStreamingResponses.push(
      toolUseResponse([{ id: 'implicit-deny', name: 'read_docs', input: { value: 'private' } }]),
      textResponse(),
    );
    const client = new AddieClaudeClient('unused');
    const result = await client.processMessage(
      'evaluation',
      undefined,
      requestTools([tool('read_docs', 'pure_local')], [['read_docs', handler]]),
      { systemPrompt: 'system' },
      { executionMode: 'evaluation' },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result.tool_executions[0]).toMatchObject({
      blocked_by_policy: true,
      parameters: {},
    });
  });

  it('suppresses evaluation notifications while preserving production behavior', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('sensitive failure'));
    const tools = requestTools([tool('failing_read', 'pure_local')], [['failing_read', handler]]);
    const client = new AddieClaudeClient('unused');

    sdkState.nonStreamingResponses.push(
      toolUseResponse([{ id: 'eval-fail', name: 'failing_read', input: { value: 'eval secret' } }]),
      textResponse(),
    );
    const evaluation = await client.processMessage(
      'evaluation', undefined, tools, { systemPrompt: 'system' },
      {
        executionMode: 'evaluation',
        disableServerTools: true,
        toolExecutionPolicy: () => ({ allowed: true }),
      },
    );
    expect(notifyToolError).not.toHaveBeenCalled();
    expect(evaluation.tool_executions[0]).toMatchObject({
      parameters: {},
      result: 'Error: Tool execution failed',
    });

    sdkState.nonStreamingResponses.push(textResponse(''));
    await client.processMessage(
      'empty evaluation', undefined, undefined, { systemPrompt: 'system' },
      { executionMode: 'evaluation', disableServerTools: true },
    );
    expect(notifySystemError).not.toHaveBeenCalled();

    sdkState.nonStreamingResponses.push(
      toolUseResponse([{ id: 'prod-fail', name: 'failing_read', input: { value: 'production input' } }]),
      textResponse(),
    );
    const production = await client.processMessage(
      'production', undefined, tools, { systemPrompt: 'system' },
      { uncapped: true, disableServerTools: true },
    );
    expect(notifyToolError).toHaveBeenCalledOnce();
    expect(production.tool_executions[0]).toMatchObject({
      parameters: { value: 'production input' },
      result: 'Error: sensitive failure',
    });
  });

  it('reports exact ordered prompt/tool hashes without transcript content', async () => {
    sdkState.nonStreamingResponses.push(textResponse());
    const snapshots: InvocationPreparedSnapshot[] = [];
    const client = new AddieClaudeClient('unused');
    client.registerTool(tool('first_tool', 'pure_local'), vi.fn().mockResolvedValue('first'));

    await client.processMessage(
      'transcript secret',
      undefined,
      requestTools([tool('second_tool', 'pure_local')], [['second_tool', vi.fn().mockResolvedValue('second')]]),
      { systemPrompt: 'system secret' },
      {
        executionMode: 'replay',
        requestContext: 'context secret',
        disableServerTools: true,
        invocationHashKey: 'test-invocation-key',
        invocationHashDomain: 'shadow-replay:v1',
        onInvocationPrepared: (snapshot) => snapshots.push(snapshot),
      },
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].tool_schemas.map((entry) => entry.name)).toEqual(['first_tool', 'second_tool']);
    expect(snapshots[0].system_blocks).toHaveLength(2);
    expect(snapshots[0].system_blocks.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(snapshots[0].tool_schemas.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(JSON.stringify(snapshots[0])).not.toMatch(/transcript secret|system secret|context secret/);

    const captured = sdkState.calls[0];
    const expectedFirstToolHash = invocationHmac(
      'test-invocation-key',
      'shadow-replay:v1',
      JSON.stringify((captured.tools as Array<Record<string, unknown>>)[0]),
    );
    expect(snapshots[0].tool_schemas[0].sha256).toBe(expectedFirstToolHash);
  });

  it('prepares the exact first non-streaming snapshot without calling the SDK', async () => {
    const client = new AddieClaudeClient('unused', 'test-model');
    client.registerTool(tool('first_tool', 'pure_local'), vi.fn().mockResolvedValue('first'));
    const scopedTools = requestTools(
      [tool('second_tool', 'pure_local')],
      [['second_tool', vi.fn().mockResolvedValue('second')]],
    );
    const dryRunCallback = vi.fn();
    const options = {
      executionMode: 'replay' as const,
      disableServerTools: true,
      requestContext: 'request context',
      invocationHashKey: 'preparation-key',
      invocationHashDomain: 'shadow-replay:v1',
      onInvocationPrepared: dryRunCallback,
    };
    const history = [
      { user: 'user', text: 'earlier question' },
      { user: 'assistant', text: 'earlier answer' },
    ];

    const prepared = client.prepareMessageInvocation(
      'current question',
      history,
      scopedTools,
      { systemPrompt: 'fixed system prompt' },
      options,
    );

    expect(sdkState.calls).toHaveLength(0);
    expect(dryRunCallback).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({
      execution_mode: 'replay',
      model: 'test-model',
      iteration: 1,
      attempt: 1,
      message_count: 1,
    });

    sdkState.nonStreamingResponses.push(textResponse());
    const actual: InvocationPreparedSnapshot[] = [];
    await client.processMessage(
      'current question',
      history,
      scopedTools,
      { systemPrompt: 'fixed system prompt' },
      { ...options, onInvocationPrepared: (snapshot) => actual.push(snapshot) },
    );

    expect(actual).toEqual([prepared]);
    expect(sdkState.calls).toHaveLength(1);
  });

  it('submits replay exactly once and logs no provider-echoed private text', async () => {
    const privateSentinel = 'private-provider-error-sentinel';
    const error = Object.assign(new Error(`temporary 500 ${privateSentinel}`), { status: 500 });
    sdkState.nonStreamingResponses.push(error);
    const client = new AddieClaudeClient('unused', 'test-model');

    await expect(client.processMessage(
      'private question',
      undefined,
      undefined,
      { systemPrompt: 'private system' },
      {
        executionMode: 'replay',
        disableServerTools: true,
        uncapped: true,
        invocationHashKey: 'no-retry-key',
        invocationHashDomain: 'no-retry-domain',
      },
    )).rejects.toThrow(privateSentinel);

    expect(sdkState.calls).toHaveLength(1);
    expect(sdkState.requestOptions).toEqual([{ maxRetries: 0 }]);
    expect(JSON.stringify(loggerState.entries)).not.toContain(privateSentinel);
  });

  it('enforces an exact request-local tool boundary in both preparation and provider calls', async () => {
    const client = new AddieClaudeClient('unused', 'test-model');
    client.registerTool(tool('global_mutation', 'mutation'), vi.fn().mockResolvedValue('bad'));
    client.registerTool(tool('search_docs', 'pure_local'), vi.fn().mockResolvedValue('search'));
    client.registerTool(tool('get_doc', 'pure_local'), vi.fn().mockResolvedValue('doc'));
    const scopedTools = requestTools(
      [tool('scoped_mutation', 'mutation')],
      [
        ['scoped_mutation', vi.fn().mockResolvedValue('bad')],
      ],
    );
    const options = {
      uncapped: true as const,
      disableServerTools: true,
      allowedToolNames: ['search_docs', 'get_doc'] as const,
      initialToolChoice: { type: 'tool' as const, name: 'search_docs' },
      invocationHashKey: 'exact-provider-boundary-key',
      invocationHashDomain: 'official-docs-test:v1',
    };

    const prepared = client.prepareMessageInvocation(
      'current question', undefined, scopedTools, { systemPrompt: 'system' }, options,
    );
    expect(client.hasRegisteredTools(options.allowedToolNames)).toBe(true);
    expect(prepared.tool_schemas.map(({ name }) => name)).toEqual(['search_docs', 'get_doc']);

    sdkState.nonStreamingResponses.push(
      toolUseResponse([{ id: 'tool-1', name: 'search_docs', input: { value: 'current question' } }]),
      textResponse(),
    );
    const actual: InvocationPreparedSnapshot[] = [];
    await client.processMessage(
      'current question', undefined, scopedTools, { systemPrompt: 'system' },
      { ...options, onInvocationPrepared: (snapshot) => actual.push(snapshot) },
    );
    expect(actual).toHaveLength(2);
    expect(actual[0]).toEqual(prepared);
    expect((sdkState.calls[0].tools as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(['search_docs', 'get_doc']);
    expect(sdkState.calls[0].tool_choice).toEqual({ type: 'tool', name: 'search_docs' });
    expect(sdkState.calls[1]).not.toHaveProperty('tool_choice');
    expect(prepared.message_payloads).toHaveLength(1);
    expect(prepared.provider_request_sha256).toBe(invocationHmac(
      options.invocationHashKey,
      options.invocationHashDomain,
      JSON.stringify(sdkState.calls[0]),
    ));
  });

  it('captures provider web-search state with request-local parity', async () => {
    const client = new AddieClaudeClient('unused');
    const hashOptions = {
      uncapped: true as const,
      invocationHashKey: 'provider-state-key',
      invocationHashDomain: 'trace-capture:v1',
    };

    const enabled = client.prepareMessageInvocation(
      'web enabled', undefined, undefined, { systemPrompt: 'system' }, hashOptions,
    );
    const disabled = client.prepareMessageInvocation(
      'web disabled', undefined, undefined, { systemPrompt: 'system' },
      { ...hashOptions, disableServerTools: true },
    );

    expect(sdkState.calls).toHaveLength(0);
    expect(enabled.tool_schemas.map((entry) => entry.name)).toContain('web_search');
    expect(disabled.tool_schemas.map((entry) => entry.name)).not.toContain('web_search');
    expect(enabled.tool_schemas.find((entry) => entry.name === 'web_search')?.sha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(client.isWebSearchEnabled()).toBe(true);

    sdkState.nonStreamingResponses.push(textResponse('enabled'));
    const actual: InvocationPreparedSnapshot[] = [];
    await client.processMessage(
      'web enabled', undefined, undefined, { systemPrompt: 'system' },
      { ...hashOptions, onInvocationPrepared: (snapshot) => actual.push(snapshot) },
    );
    expect(actual).toEqual([enabled]);
    expect((sdkState.calls[0].tools as Array<{ name?: string }>).some(({ name }) => name === 'web_search'))
      .toBe(true);
  });

  it('fails closed for partial HMAC configuration and separates caller domains from mode', () => {
    const client = new AddieClaudeClient('unused');
    client.registerTool(tool('read_docs', 'pure_local'), vi.fn().mockResolvedValue('docs'));
    const prepare = (options: Parameters<AddieClaudeClient['prepareMessageInvocation']>[4]) =>
      client.prepareMessageInvocation(
        'private transcript',
        undefined,
        undefined,
        { systemPrompt: 'private system prompt' },
        { disableServerTools: true, ...options },
      );

    const missing = prepare({ executionMode: 'replay' });
    const keyOnly = prepare({ executionMode: 'replay', invocationHashKey: 'key-a' });
    const domainOnly = prepare({ executionMode: 'replay', invocationHashDomain: 'domain-a' });
    for (const snapshot of [missing, keyOnly, domainOnly]) {
      expect(snapshot.system_blocks.every(({ sha256 }) => sha256 === 'unavailable')).toBe(true);
      expect(snapshot.tool_schemas.every(({ sha256 }) => sha256 === 'unavailable')).toBe(true);
    }

    const replayA = prepare({
      executionMode: 'replay',
      invocationHashKey: 'key-a',
      invocationHashDomain: 'domain-a',
    });
    const replayB = prepare({
      executionMode: 'replay',
      invocationHashKey: 'key-a',
      invocationHashDomain: 'domain-b',
    });
    const productionA = prepare({
      executionMode: 'production',
      invocationHashKey: 'key-a',
      invocationHashDomain: 'domain-a',
    });
    expect(replayA.system_blocks[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(replayA.system_blocks[0].sha256).not.toBe(replayB.system_blocks[0].sha256);
    expect(replayA.system_blocks[0].sha256).toBe(productionA.system_blocks[0].sha256);
    expect(prepare({ invocationHashKey: 'key-a' }).system_blocks[0].sha256).toBe('unavailable');
    expect(prepare({}).system_blocks[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sdkState.calls).toHaveLength(0);
  });

  it('preserves production custom schemas while intrinsically omitting provider tools', async () => {
    sdkState.nonStreamingResponses.push(textResponse('production'), textResponse('replay'));
    const client = new AddieClaudeClient('unused');
    client.registerTool(tool('read_docs', 'pure_local'), vi.fn().mockResolvedValue('docs'));

    await client.processMessage(
      'production', undefined, undefined, { systemPrompt: 'system' }, { uncapped: true },
    );
    await client.processMessage(
      'replay', undefined, undefined, { systemPrompt: 'system' }, {
        executionMode: 'replay',
        toolExecutionPolicy: ({ tool: definition }) => ({
          allowed: definition?.replaySafety === 'pure_local',
        }),
      },
    );

    const productionTools = sdkState.calls[0].tools as Array<Record<string, unknown>>;
    const replayTools = sdkState.calls[1].tools as Array<Record<string, unknown>>;
    expect(productionTools.find((entry) => entry.name === 'read_docs')).toEqual(
      replayTools.find((entry) => entry.name === 'read_docs'),
    );
    expect(productionTools.some((entry) => entry.name === 'web_search')).toBe(true);
    expect(replayTools.some((entry) => entry.name === 'web_search')).toBe(false);
  });

  it('keeps the large cacheable prompt block stable across routed domains', () => {
    const client = new AddieClaudeClient('unused', 'test-model');
    client.registerTool(tool('query_prospects', 'pure_local'), vi.fn().mockResolvedValue('prospects'));
    client.registerTool(tool('merge_organizations', 'mutation'), vi.fn().mockResolvedValue('merged'));
    const prepare = (selectedToolSetNames: string[], allowedToolNames: string[]) =>
      client.prepareMessageInvocation(
        'current question',
        undefined,
        undefined,
        undefined,
        {
          executionMode: 'replay',
          disableServerTools: true,
          selectedToolSetNames,
          allowedToolNames,
          invocationHashKey: 'prompt-cache-key',
          invocationHashDomain: 'prompt-cache-test:v1',
        },
      );

    const prospects = prepare(['admin_prospects'], ['query_prospects']);
    const organizations = prepare(['admin_organizations'], ['merge_organizations']);

    expect(prospects.system_blocks).toHaveLength(3);
    expect(organizations.system_blocks).toHaveLength(3);
    expect(prospects.system_blocks[0].sha256).toBe(organizations.system_blocks[0].sha256);
    expect(prospects.system_blocks[1].sha256).not.toBe(organizations.system_blocks[1].sha256);
    expect(prospects.system_blocks[2].sha256).toBe(organizations.system_blocks[2].sha256);
  });
});
