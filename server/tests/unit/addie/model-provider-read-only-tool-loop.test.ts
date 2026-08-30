import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicModelProvider,
  type AnthropicMessagesTransport,
} from '../../../src/addie/model-providers/anthropic-provider.js';
import type { ModelRequest } from '../../../src/addie/model-providers/model-provider.js';
import {
  executeReadOnlyToolLoop,
  ReadOnlyToolLoopBoundaryError,
} from '../../../src/addie/model-providers/read-only-tool-loop.js';
import {
  buildReadOnlyToolLoopCompatibilityFailureReport,
  buildReadOnlyToolLoopFailureReport,
} from '../../../src/addie/model-providers/read-only-tool-loop-report.js';

function request(): ModelRequest {
  return {
    model: 'claude-test',
    system: [{ text: 'Use official docs.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What version is stable?' }] }],
    tools: [],
    maxOutputTokens: 300,
  };
}

function response(
  content: Array<Record<string, unknown>>,
  stopReason: string,
  id: string,
): Record<string, unknown> {
  return {
    id,
    model: 'claude-test',
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const tool = (handler: (input: Readonly<Record<string, unknown>>) => Promise<string>) => ({
  definition: {
    name: 'search_docs',
    description: 'Search official documentation.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  replaySafety: 'pure_local',
  handler,
});

const allowPureLocalTool = () => ({ allowed: true as const });

describe('executeReadOnlyToolLoop', () => {
  it('uses the same bounded orchestration with the Anthropic adapter', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(response([{
        type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'stable version' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(response([{
        type: 'text', text: 'The stable version is documented in the release notes.',
      }], 'end_turn', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const handler = vi.fn().mockResolvedValue('Stable release notes result.');

    const result = await executeReadOnlyToolLoop(provider, request(), [tool(handler)], {
      authorizeToolExecution: allowPureLocalTool,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].messages).toEqual([
      { role: 'user', content: 'What version is stable?' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'stable version' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_1',
          content: 'Stable release notes result.',
        }],
      },
    ]);
    expect(create.mock.calls.every((call) => call[1].maxRetries === 0)).toBe(true);
    expect(result.text).toContain('stable version');
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it('turns handler failures into bounded tool errors without exposing exception text', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(response([{
        type: 'tool_use', id: 'PRIVATE_TOOL_ID_SENTINEL', name: 'search_docs', input: { query: 'stable version' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(response([{ type: 'text', text: 'I could not read the docs.' }], 'end_turn', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const handler = vi.fn().mockRejectedValue(new Error('PRIVATE_SENTINEL'));

    const result = await executeReadOnlyToolLoop(provider, request(), [tool(handler)], {
      authorizeToolExecution: allowPureLocalTool,
    });

    expect(create.mock.calls[1][0].messages[2].content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'PRIVATE_TOOL_ID_SENTINEL',
      content: 'Tool execution failed.',
      is_error: true,
    }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TOOL_ID_SENTINEL');
    expect(result.toolExecutions[0].disposition).toBe('handler_error');
  });

  it('blocks a second tool call before executing it', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(response([{
        type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'one' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(response([{
        type: 'tool_use', id: 'tool_2', name: 'search_docs', input: { query: 'two' },
      }], 'tool_use', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const handler = vi.fn().mockResolvedValue('result');

    await expect(executeReadOnlyToolLoop(provider, request(), [tool(handler)], {
      authorizeToolExecution: allowPureLocalTool,
    }))
      .rejects.toEqual(new ReadOnlyToolLoopBoundaryError('tool_call_limit_exceeded'));
    expect(handler).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('snapshots tool metadata and requires last-moment policy authorization', async () => {
    const create = vi.fn().mockResolvedValue(response([{
      type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'stable version' },
    }], 'tool_use', 'msg_1'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const originalHandler = vi.fn().mockResolvedValue('result');
    const replacementHandler = vi.fn().mockResolvedValue('replacement');
    const mutableTool = tool(originalHandler);
    const policy = vi.fn().mockReturnValue({ allowed: false as const });

    await expect(executeReadOnlyToolLoop(provider, request(), [mutableTool], {
      beforeDispatch: () => {
        mutableTool.replaySafety = 'mutation';
        mutableTool.handler = replacementHandler;
        mutableTool.definition.name = 'renamed_tool';
      },
      authorizeToolExecution: policy,
    })).rejects.toEqual(new ReadOnlyToolLoopBoundaryError('tool_policy_rejected'));

    expect(policy).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'tool_1',
      toolName: 'search_docs',
      toolInput: { query: 'stable version' },
      replaySafety: 'pure_local',
    }));
    expect(originalHandler).not.toHaveBeenCalled();
    expect(replacementHandler).not.toHaveBeenCalled();
  });

  it('snapshots the initial request before dispatch callbacks can mutate it', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(response([{
        type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'stable version' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(response([{ type: 'text', text: 'Stable.' }], 'end_turn', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const mutableRequest = request();

    await executeReadOnlyToolLoop(provider, mutableRequest, [tool(vi.fn().mockResolvedValue('result'))], {
      authorizeToolExecution: allowPureLocalTool,
      beforeDispatch: () => {
        mutableRequest.model = 'mutated-model';
        mutableRequest.maxOutputTokens = 1;
        mutableRequest.system[0].text = 'mutated-system';
      },
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toMatchObject({
      model: 'claude-test',
      max_tokens: 300,
      system: [{ type: 'text', text: 'Use official docs.' }],
    });
  });

  it('uses one frozen validated tool input for authorization and execution', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(response([{
        type: 'tool_use', id: 'tool_1', name: 'search_docs', input: { query: 'stable version' },
      }], 'tool_use', 'msg_1'))
      .mockResolvedValueOnce(response([{ type: 'text', text: 'Stable.' }], 'end_turn', 'msg_2'));
    const provider = new AnthropicModelProvider('unused', {
      beta: { messages: { create } },
    } as AnthropicMessagesTransport);
    const handler = vi.fn().mockResolvedValue('result');

    await executeReadOnlyToolLoop(provider, request(), [tool(handler)], {
      authorizeToolExecution: async (authorization) => {
        expect(Object.isFrozen(authorization.toolInput)).toBe(true);
        expect(Reflect.set(authorization.toolInput, 'query', 'mutated')).toBe(false);
        await Promise.resolve();
        return { allowed: true };
      },
    });

    expect(handler).toHaveBeenCalledWith({ query: 'stable version' });
  });

  it('reports paid failure accounting without serializing provider error text', () => {
    const report = buildReadOnlyToolLoopFailureReport({
      requestedProvider: 'google',
      requestedModel: 'gemini-test',
      sourceSha256: 'source',
      gitCommit: 'commit',
      gitDirty: true,
      docsCorpusSha256: 'docs',
      invocationSha256: ['request-hash'],
      latencyMs: 123,
      error: new Error('PRIVATE_PROVIDER_SENTINEL'),
      timedOut: false,
    });

    expect(report).toMatchObject({
      status: 'error',
      reason: 'provider_error',
      usage_known: false,
      max_dispatches: 2,
      dispatch_count: 1,
      requested_provider: 'google',
      requested_model: 'gemini-test',
      invocation_sha256: ['request-hash'],
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_PROVIDER_SENTINEL');
  });

  it('keeps known usage when a completed response fails the compatibility assertion', () => {
    const report = buildReadOnlyToolLoopCompatibilityFailureReport({
      requestedProvider: 'google',
      requestedModel: 'gemini-test',
      sourceSha256: 'source',
      gitCommit: 'commit',
      gitDirty: true,
      docsCorpusSha256: 'docs',
      invocationSha256: ['request-hash'],
      latencyMs: 123,
      result: {
        response: {
          provider: 'google',
          model: 'gemini-test',
          id: 'response',
          content: [{ type: 'text', text: 'PRIVATE_OUTPUT_SENTINEL' }],
          finishReason: 'stop',
          providerFinishReason: 'STOP',
          usage: { inputTokens: 7, outputTokens: 3 },
        },
        text: 'PRIVATE_OUTPUT_SENTINEL',
        iterations: 1,
        usage: { inputTokens: 7, outputTokens: 3 },
        toolExecutions: [],
      },
    });

    expect(report).toMatchObject({
      status: 'failed',
      reason: 'compatibility_failed',
      usage_known: true,
      dispatch_count: 1,
      provider: 'google',
      model: 'gemini-test',
      finish_reason: 'stop',
      tool_executions: [],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_OUTPUT_SENTINEL');
  });
});
