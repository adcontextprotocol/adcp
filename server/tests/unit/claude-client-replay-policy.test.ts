import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkState = vi.hoisted(() => ({
  nonStreamingResponses: [] as Array<Record<string, unknown>>,
  streamingResponses: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Record<string, unknown>>,
}));

const notifyToolError = vi.hoisted(() => vi.fn());
const notifySystemError = vi.hoisted(() => vi.fn());

vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError,
  notifyToolError,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        create: vi.fn(async (payload: Record<string, unknown>) => {
          sdkState.calls.push(payload);
          const response = sdkState.nonStreamingResponses.shift();
          if (!response) throw new Error('Missing non-streaming response fixture');
          return response;
        }),
        stream: vi.fn((payload: Record<string, unknown>) => {
          sdkState.calls.push(payload);
          const response = sdkState.streamingResponses.shift();
          if (!response) throw new Error('Missing streaming response fixture');
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn().mockResolvedValue(response),
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

beforeEach(() => {
  sdkState.nonStreamingResponses.length = 0;
  sdkState.streamingResponses.length = 0;
  sdkState.calls.length = 0;
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
    const expectedFirstToolHash = createHmac('sha256', 'test-invocation-key')
      .update(JSON.stringify((captured.tools as Array<Record<string, unknown>>)[0]), 'utf8')
      .digest('hex');
    expect(snapshots[0].tool_schemas[0].sha256).toBe(expectedFirstToolHash);
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
});
