import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
  checkCostCap: vi.fn(),
  recordCost: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  APIError: class APIError extends Error {},
  APIConnectionError: class APIConnectionError extends Error {},
  default: class {
    beta = {
      messages: {
        create: async (payload: Record<string, unknown>, options?: unknown) => ({
          id: 'msg_model_fallback',
          model: String(payload.model),
          ...await mocks.createMessage(payload, options),
        }),
        stream: (payload: Record<string, unknown>, options?: unknown) => {
          const stream = mocks.streamMessage(payload, options);
          return {
            [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
            finalMessage: async () => ({
              id: 'msg_stream_model_fallback',
              model: String(payload.model),
              ...await stream.finalMessage(),
            }),
          };
        },
      },
    };
  },
}));

vi.mock('../../../src/addie/error-notifier.js', () => ({
  notifySystemError: vi.fn(),
  notifyToolError: vi.fn(),
}));

vi.mock('../../../src/addie/config-version.js', () => ({
  getCurrentConfigVersionId: vi.fn().mockResolvedValue(120),
}));

vi.mock('../../../src/addie/rules/index.js', () => ({
  loadCoreRules: vi.fn(() => 'You are Addie.'),
  loadScopedRules: vi.fn(() => ''),
  loadConstraintRules: vi.fn(() => 'Use tools honestly.'),
  loadResponseStyle: vi.fn(() => 'Answer clearly.'),
  invalidateRulesCache: vi.fn(),
}));

vi.mock('../../../src/db/addie-db.js', () => ({ AddieDatabase: class {} }));

vi.mock('../../../src/addie/claude-cost-tracker.js', () => ({
  checkCostCap: mocks.checkCostCap,
  recordCost: mocks.recordCost,
  releaseCertificationReserve: vi.fn(),
  renewCertificationReserve: vi.fn(),
  formatCapExceededMessage: vi.fn(() => 'cap exceeded'),
}));

import { AddieClaudeClient, type StreamEvent } from '../../../src/addie/claude-client.js';
import { AddieModelConfig, ModelConfig } from '../../../src/config/models.js';

const toolUseTurn = {
  stop_reason: 'tool_use',
  content: [{
    type: 'tool_use',
    id: 'toolu_fallback',
    name: 'get_github_issue',
    input: { issue_number: 42 },
  }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

const getGithubIssue = vi.fn().mockResolvedValue('{"number":42,"state":"open"}');
const githubIssueTools = {
  tools: [{
    name: 'get_github_issue',
    description: 'Get an issue',
    input_schema: { type: 'object' as const, properties: {} },
  }],
  handlers: new Map([['get_github_issue', getGithubIssue]]),
};

function exhaustedError(): Error {
  return Object.assign(new Error('overloaded_error'), {
    status: 529,
    headers: { 'retry-after': '31' },
  });
}

function makeThrowingStream(error: Error, withDelta = false) {
  return {
    async *[Symbol.asyncIterator]() {
      if (withDelta) {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        };
      }
      throw error;
    },
    finalMessage: vi.fn(),
  };
}

function makeTextStream(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      };
    },
    finalMessage: vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
  };
}

describe('Addie provider delivery runtime', () => {
  beforeEach(() => {
    mocks.createMessage.mockReset();
    mocks.streamMessage.mockReset();
    mocks.checkCostCap.mockReset().mockResolvedValue({ ok: true });
    mocks.recordCost.mockReset().mockResolvedValue(undefined);
    getGithubIssue.mockClear();
  });

  it('falls back once before accepting work and records actual model cost', async () => {
    mocks.createMessage.mockImplementation(async (payload: Record<string, unknown>) => {
      if (payload.model === ModelConfig.fast) throw exhaustedError();
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Fallback answer.' }],
        usage: { input_tokens: 12, output_tokens: 4 },
      };
    });

    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      {
        modelOverride: ModelConfig.fast,
        costScope: { userId: 'fallback-user', tier: 'member_free' },
      },
    );

    expect(mocks.createMessage.mock.calls.map(([payload]) => payload.model)).toEqual([
      ModelConfig.fast,
      AddieModelConfig.chat,
    ]);
    expect(response.text).toBe('Fallback answer.');
    expect(response.model_execution).toEqual({
      source: 'provider',
      requested_provider: 'anthropic',
      requested_model: ModelConfig.fast,
      provider: 'anthropic',
      model: AddieModelConfig.chat,
      model_resolution: 'fallback',
      fallback_reason: 'primary_unavailable',
    });
    expect(mocks.recordCost).toHaveBeenCalledWith(
      'fallback-user',
      expect.objectContaining({
        provider: 'anthropic',
        model: AddieModelConfig.chat,
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 4 }),
      }),
    );
  });

  it('pins later tool continuations to the successful sibling model', async () => {
    let fallbackCalls = 0;
    mocks.createMessage.mockImplementation(async (payload: Record<string, unknown>) => {
      if (payload.model === ModelConfig.fast) throw exhaustedError();
      fallbackCalls++;
      if (fallbackCalls === 1) return toolUseTurn;
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Issue 42 is open.' }],
        usage: { input_tokens: 12, output_tokens: 6 },
      };
    });

    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { modelOverride: ModelConfig.fast, uncapped: true },
    );

    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.createMessage.mock.calls.map(([payload]) => payload.model)).toEqual([
      ModelConfig.fast,
      AddieModelConfig.chat,
      AddieModelConfig.chat,
    ]);
    expect(response.model_execution).toMatchObject({
      requested_model: ModelConfig.fast,
      model: AddieModelConfig.chat,
      model_resolution: 'fallback',
      fallback_reason: 'primary_unavailable',
    });
  });

  it('surfaces failure after the one-shot sibling fallback also fails', async () => {
    const fallbackError = new Error('fallback authentication failed');
    mocks.createMessage.mockImplementation(async (payload: Record<string, unknown>) => {
      if (payload.model === ModelConfig.fast) throw exhaustedError();
      throw fallbackError;
    });

    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    await expect(client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { modelOverride: ModelConfig.fast, uncapped: true },
    )).rejects.toBe(fallbackError);
    expect(mocks.createMessage.mock.calls.map(([payload]) => payload.model)).toEqual([
      ModelConfig.fast,
      AddieModelConfig.chat,
    ]);
  });

  it('never falls back after a custom tool has executed', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(toolUseTurn)
      .mockRejectedValueOnce(exhaustedError());

    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { modelOverride: ModelConfig.fast, uncapped: true },
    );

    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      flagged: true,
      flag_reason: 'provider_unavailable:overloaded',
      model_execution: { source: 'local', reason: 'provider_error' },
    });
    expect(mocks.createMessage.mock.calls.map(([payload]) => payload.model)).toEqual([
      ModelConfig.fast,
      ModelConfig.fast,
    ]);
  });

  it('uses the same pre-delta fallback policy for streaming delivery', async () => {
    mocks.streamMessage.mockImplementation((payload: Record<string, unknown>) => (
      payload.model === ModelConfig.fast
        ? makeThrowingStream(exhaustedError())
        : makeTextStream('Fallback answer.')
    ));

    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { modelOverride: ModelConfig.fast, uncapped: true },
    )) events.push(event);

    expect(mocks.streamMessage.mock.calls.map(([payload]) => payload.model)).toEqual([
      ModelConfig.fast,
      AddieModelConfig.chat,
    ]);
    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );
    expect(done?.response.model_execution).toMatchObject({
      requested_model: ModelConfig.fast,
      model: AddieModelConfig.chat,
      model_resolution: 'fallback',
      fallback_reason: 'primary_unavailable',
    });
    expect(events.filter(event => event.type === 'text')).toEqual([
      { type: 'text', text: 'Fallback answer.' },
    ]);
    expect(events.some(event => event.type === 'stream_error')).toBe(false);
  });

  it('prepares identical canonical inputs for streaming and non-streaming delivery', async () => {
    mocks.createMessage.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Prepared answer.' }],
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    mocks.streamMessage.mockReturnValue(makeTextStream('Prepared answer.'));

    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    client.setWebSearchEnabled(false);
    const threadContext = [
      { user: 'user', text: 'Earlier question' },
      { user: 'assistant', text: 'Earlier answer' },
    ];
    const options = {
      uncapped: true,
      requestContext: 'Account context',
      currentSpeakerName: 'Casey',
    } as const;

    await client.processMessage(
      'Current question',
      threadContext,
      githubIssueTools,
      undefined,
      options,
    );
    for await (const _event of client.processMessageStream(
      'Current question',
      threadContext,
      githubIssueTools,
      options,
    )) {
      // Consume the complete streaming response.
    }

    const nonStreamingPayload = mocks.createMessage.mock.calls[0]?.[0];
    const streamingPayload = mocks.streamMessage.mock.calls[0]?.[0];
    if (!nonStreamingPayload || !streamingPayload) {
      throw new Error('Expected both delivery modes to dispatch one provider request');
    }
    expect(streamingPayload).toEqual(expect.objectContaining({
      model: nonStreamingPayload.model,
      system: nonStreamingPayload.system,
      messages: nonStreamingPayload.messages,
      tools: nonStreamingPayload.tools,
    }));
  });

  it('refuses a production mutation when the caller supplied a reservation but no authority capture', async () => {
    mocks.createMessage.mockResolvedValueOnce({
      stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'authority-call', name: 'schedule_meeting', input: { title: 'Review' } }],
      usage: { input_tokens: 12, output_tokens: 4 },
    }).mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Action was not dispatched.' }], usage: { input_tokens: 12, output_tokens: 4 } });
    const handler = vi.fn().mockResolvedValue('Meeting scheduled');
    const reserve = vi.fn().mockResolvedValue({ reservationId: 'owned-intent' });
    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    const response = await client.processMessage('Schedule a meeting', [], {
      tools: [{ name: 'schedule_meeting', description: 'Schedule a meeting', input_schema: { type: 'object', properties: {} } }],
      handlers: new Map([['schedule_meeting', handler]]),
    }, undefined, { uncapped: true, allowedToolNames: ['schedule_meeting'], reserveSideEffect: reserve });
    expect(handler).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(response.tool_executions[0]).toMatchObject({ dispatch_status: 'not_dispatched', normalized_result: { status: 'recoverable_error' } });
  });

  it.each(['create_github_issue', 'call_adcp_task'])('captures authority for the final filtered %s surface', async mutationName => {
    mocks.createMessage.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Prepared answer.' }],
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    const createIssue = {
      name: mutationName,
      description: 'Execute a mutation',
      input_schema: { type: 'object' as const, properties: {} },
    };
    const requestTools = {
      tools: [...githubIssueTools.tools, createIssue],
      handlers: new Map([
        ...githubIssueTools.handlers,
        [mutationName, vi.fn().mockResolvedValue('{}')],
      ]),
    };
    const captureSideEffectAuthority = vi.fn().mockResolvedValue(vi.fn());
    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);

    await client.processMessage('read only', [], requestTools, undefined, {
      uncapped: true,
      allowedToolNames: ['get_github_issue'],
      captureSideEffectAuthority,
    });
    expect(captureSideEffectAuthority).not.toHaveBeenCalled();

    await client.processMessage('create it', [], requestTools, undefined, {
      uncapped: true,
      allowedToolNames: [mutationName],
      captureSideEffectAuthority,
    });
    expect(captureSideEffectAuthority).toHaveBeenCalledOnce();
    expect(captureSideEffectAuthority).toHaveBeenCalledWith({
      mutationToolNames: [mutationName],
    });
  });

  it('does not change models after any streamed delta was received', async () => {
    mocks.streamMessage.mockReturnValue(makeThrowingStream(exhaustedError(), true));

    const client = new AddieClaudeClient('unused', AddieModelConfig.chat);
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { modelOverride: ModelConfig.fast, uncapped: true },
    )) events.push(event);

    expect(mocks.streamMessage.mock.calls.map(([payload]) => payload.model)).toEqual([
      ModelConfig.fast,
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      response: expect.objectContaining({
        flagged: true,
        flag_reason: 'provider_unavailable:overloaded',
      }),
    }));
  });
});
