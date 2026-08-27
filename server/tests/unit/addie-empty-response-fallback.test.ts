import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
  notifySystemError: vi.fn(),
  notifyToolError: vi.fn(),
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
          id: 'msg_test_nonstreaming',
          model: String(payload.model),
          ...await mocks.createMessage(payload, options),
        }),
        stream: mocks.streamMessage,
      },
    };
  },
}));

vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError: mocks.notifySystemError,
  notifyToolError: mocks.notifyToolError,
}));

vi.mock('../../src/addie/config-version.js', () => ({
  getCurrentConfigVersionId: vi.fn().mockResolvedValue(123),
}));

vi.mock('../../src/addie/rules/index.js', () => ({
  loadRules: vi.fn(() => 'You are Addie.'),
  loadResponseStyle: vi.fn(() => 'Answer clearly.'),
  invalidateRulesCache: vi.fn(),
}));

vi.mock('../../src/db/addie-db.js', () => ({
  AddieDatabase: class {},
}));

vi.mock('../../src/addie/claude-cost-tracker.js', () => ({
  checkCostCap: mocks.checkCostCap,
  recordCost: mocks.recordCost,
  releaseCertificationReserve: vi.fn(),
  renewCertificationReserve: vi.fn(),
  formatCapExceededMessage: vi.fn(() => 'cap exceeded'),
}));

import {
  ADDIE_EMPTY_RESPONSE_FALLBACK,
  AddieClaudeClient,
  type StreamEvent,
} from '../../src/addie/claude-client.js';

const emptyEndTurn = {
  model: 'claude-sonnet-4-6-20260801',
  stop_reason: 'end_turn',
  content: [],
  usage: {
    input_tokens: 10,
    output_tokens: 0,
  },
};

const toolUseTurn = {
  model: 'claude-sonnet-4-6-20260801',
  stop_reason: 'tool_use',
  content: [{
    type: 'tool_use',
    id: 'toolu_1',
    name: 'get_github_issue',
    input: { issue_number: 42 },
  }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

const searchToolUseTurn = {
  ...toolUseTurn,
  content: [{
    type: 'tool_use',
    id: 'toolu_search',
    name: 'search_docs',
    input: { query: 'missing term' },
  }],
};

const recoveredEndTurn = {
  model: 'claude-sonnet-5-20260801',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'Issue 42 is open.' }],
  usage: { input_tokens: 12, output_tokens: 6 },
};

const thinkingOnlyEndTurn = {
  model: 'claude-sonnet-5-20260801',
  stop_reason: 'end_turn',
  content: [{
    type: 'thinking',
    thinking: 'PRIVATE_REASONING_SENTINEL',
    signature: 'private-signature',
  }],
  usage: {
    input_tokens: 10,
    output_tokens: 9,
    output_tokens_details: { thinking_tokens: 9 },
  },
};

const blankTextEndTurn = {
  model: 'claude-sonnet-5-20260801',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '  \n\t' }],
  usage: { input_tokens: 10, output_tokens: 1 },
};

const ritualOnlyEndTurn = {
  model: 'claude-sonnet-5-20260801',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'Great question.' }],
  usage: { input_tokens: 10, output_tokens: 3 },
};

const redactedThinkingOnlyEndTurn = {
  model: 'claude-sonnet-5-20260801',
  stop_reason: 'end_turn',
  content: [{ type: 'redacted_thinking', data: 'PRIVATE_REDACTED_SENTINEL' }],
  usage: { input_tokens: 10, output_tokens: 4 },
};

const toolBlockEndTurn = {
  ...toolUseTurn,
  stop_reason: 'end_turn',
};

const personaOnlyEndTurn = {
  model: 'claude-sonnet-5-20260801',
  stop_reason: 'end_turn',
  content: [{
    type: 'text',
    text: "I'm Claude, an AI assistant made by Anthropic. As a large language model, I have no real-world identity.",
  }],
  usage: { input_tokens: 12, output_tokens: 20 },
};

const semanticRefusalEndTurn = {
  model: 'claude-sonnet-5-20260801',
  stop_reason: 'end_turn',
  content: [{
    type: 'text',
    text: 'As a large language model, I cannot help with that request.',
  }],
  usage: { input_tokens: 12, output_tokens: 14 },
};

const emptyToolUseTurn = {
  ...emptyEndTurn,
  stop_reason: 'tool_use',
};

const emptyRefusal = {
  ...emptyEndTurn,
  stop_reason: 'refusal',
};

const mixedRecoveryToolUseTurn = {
  ...toolUseTurn,
  content: [
    { type: 'text', text: 'I updated it again.' },
    ...toolUseTurn.content,
  ],
};

const webSearchResultOnlyEndTurn = {
  stop_reason: 'end_turn',
  content: [
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'AdCP issue 42' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
};

function makeEmptyStream() {
  return {
    async *[Symbol.asyncIterator]() {
      // No deltas: this is the silent-response failure shape.
    },
    finalMessage: vi.fn().mockResolvedValue(emptyEndTurn),
  };
}

function makeTextDeltaStreamWithEmptyFinal(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
    },
    finalMessage: vi.fn().mockResolvedValue(emptyEndTurn),
  };
}

function makeThinkingDeltaStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'PRIVATE_REASONING_SENTINEL' },
      };
    },
    finalMessage: vi.fn().mockResolvedValue(thinkingOnlyEndTurn),
  };
}

function makeThrowingStream(error: Error) {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    finalMessage: vi.fn(),
  };
}

function makeStream(message: typeof toolUseTurn | typeof searchToolUseTurn | typeof emptyEndTurn | typeof recoveredEndTurn | typeof personaOnlyEndTurn | typeof semanticRefusalEndTurn | typeof mixedRecoveryToolUseTurn | typeof emptyRefusal | typeof thinkingOnlyEndTurn | typeof redactedThinkingOnlyEndTurn | typeof blankTextEndTurn | typeof ritualOnlyEndTurn) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const block of message.content) {
        if (block.type === 'text') {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: block.text } };
        }
      }
    },
    finalMessage: vi.fn().mockResolvedValue(message),
  };
}

const getGithubIssue = vi.fn().mockResolvedValue('{"number":42,"state":"open"}');
const githubIssueTools = {
  tools: [{
    name: 'get_github_issue',
    description: 'Get an issue',
    input_schema: { type: 'object' as const, properties: {} },
  }],
  handlers: new Map([['get_github_issue', getGithubIssue]]),
};

const emptyDocsResult = 'No documentation found in AdCP 3.2-beta for: "missing term"\n\nTry another query.';
const searchDocs = vi.fn().mockResolvedValue(emptyDocsResult);
const searchDocsTools = {
  tools: [{
    name: 'search_docs',
    description: 'Search docs',
    input_schema: { type: 'object' as const, properties: {} },
  }],
  handlers: new Map([['search_docs', searchDocs]]),
};

describe('Addie empty-response fallback (#4430)', () => {
  beforeEach(() => {
    mocks.createMessage.mockReset();
    mocks.streamMessage.mockReset();
    mocks.notifySystemError.mockReset();
    mocks.notifyToolError.mockReset();
    mocks.checkCostCap.mockReset().mockResolvedValue({ ok: true });
    mocks.recordCost.mockReset().mockResolvedValue(undefined);
    getGithubIssue.mockClear();
    searchDocs.mockClear();
  });

  it('returns fallback text and sends monitoring for non-streaming empty responses', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(emptyEndTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true, threadId: 'thread-empty', userDisplayName: 'Ari' },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(response.flagged).toBe(true);
    expect(response.flag_reason).toContain('Empty turn');
    expect(response.model_execution).toEqual({
      source: 'local',
      requested_provider: 'anthropic',
      requested_model: 'claude-sonnet-4-6',
      reason: 'no_provider_response',
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
    expect(mocks.createMessage.mock.calls[0][0]).toMatchObject({ max_tokens: 8_192 });
    expect(mocks.createMessage.mock.calls[0][0]).not.toHaveProperty('output_config');
    expect(mocks.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'addie-empty-response',
      errorMessage: expect.stringContaining('thread-empty'),
    }));
  });

  it('yields fallback text before done for streaming empty responses', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeEmptyStream())
      .mockReturnValueOnce(makeEmptyStream());

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true, threadId: 'thread-stream-empty', userDisplayName: 'Ari' },
    )) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'text', text: ADDIE_EMPTY_RESPONSE_FALLBACK });
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(done?.response.flagged).toBe(true);
    expect(done?.response.flag_reason).toContain('Empty turn');
    expect(done?.response.model_execution).toEqual({
      source: 'local',
      requested_provider: 'anthropic',
      requested_model: 'claude-sonnet-4-6',
      reason: 'no_provider_response',
    });
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'addie-empty-response',
      errorMessage: expect.stringContaining('processMessageStream'),
    }));
  });

  it('classifies persona-only provider output as a local fallback without resampling', async () => {
    mocks.createMessage.mockResolvedValueOnce(personaOnlyEndTurn);
    mocks.streamMessage.mockReturnValueOnce(makeStream(personaOnlyEndTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'who are you?',
      undefined,
      undefined,
      undefined,
      { uncapped: true, threadId: 'thread-persona-only' },
    );
    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(response.flag_reason).toContain('persona-collapse');
    expect(response.model_execution).toEqual({
      source: 'local',
      requested_provider: 'anthropic',
      requested_model: 'claude-sonnet-5',
      reason: 'no_provider_response',
    });
    expect(mocks.createMessage).toHaveBeenCalledOnce();

    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'who are you?',
      undefined,
      undefined,
      { uncapped: true, threadId: 'thread-stream-persona-only' },
    )) {
      events.push(event);
    }
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(done?.response.flag_reason).toContain('persona-collapse');
    expect(done?.response.model_execution).toEqual({
      source: 'local',
      requested_provider: 'anthropic',
      requested_model: 'claude-sonnet-5',
      reason: 'no_provider_response',
    });
    expect(mocks.streamMessage).toHaveBeenCalledOnce();
  });

  it('never resamples a semantic refusal returned as end_turn', async () => {
    mocks.createMessage.mockResolvedValueOnce(semanticRefusalEndTurn);
    mocks.streamMessage.mockReturnValueOnce(makeStream(semanticRefusalEndTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'perform the blocked action',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true },
    );
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'perform the blocked action',
      undefined,
      githubIssueTools,
      { uncapped: true },
    )) events.push(event);

    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );
    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(mocks.createMessage).toHaveBeenCalledOnce();
    expect(mocks.streamMessage).toHaveBeenCalledOnce();
    expect(getGithubIssue).not.toHaveBeenCalled();
  });

  it('rejects a malformed non-streaming tool turn while streaming retains its local fallback', async () => {
    mocks.createMessage.mockResolvedValueOnce(emptyToolUseTurn);
    mocks.streamMessage.mockReturnValueOnce(makeStream(emptyToolUseTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    await expect(client.processMessage(
      'hello', undefined, undefined, undefined, { uncapped: true },
    )).rejects.toThrow('Tool-call finish has no tool call');
    const streamEvents: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello', undefined, undefined, { uncapped: true },
    )) streamEvents.push(event);
    const done = streamEvents.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );

    expect(done?.response.model_execution).toEqual({
      source: 'local', requested_provider: 'anthropic', requested_model: 'claude-sonnet-4-6', reason: 'no_provider_response',
    });
  });

  it('classifies the non-streaming max-iteration apology as local', async () => {
    mocks.createMessage.mockResolvedValueOnce(toolUseTurn);
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'hello',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true, maxIterations: 1 },
    );

    expect(response.flag_reason).toBe('Max tool iterations reached');
    expect(response.model_execution).toEqual({
      source: 'local', requested_provider: 'anthropic', requested_model: 'claude-sonnet-4-6', reason: 'canned_response',
    });
  });

  it('classifies the streaming max-iteration apology as local', async () => {
    mocks.streamMessage.mockReturnValueOnce(makeStream(toolUseTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello', undefined, githubIssueTools, { uncapped: true, maxIterations: 1 },
    )) events.push(event);
    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );

    expect(done?.response.flag_reason).toBe('Max tool iterations reached');
    expect(done?.response.model_execution).toEqual({
      source: 'local', requested_provider: 'anthropic', requested_model: 'claude-sonnet-4-6', reason: 'canned_response',
    });
  });

  it('recovers once from a wholly empty initial non-streaming response', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(recoveredEndTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true, threadId: 'thread-initial-recovered' },
    );

    expect(response.text).toBe('Issue 42 is open.');
    expect(response.timing?.iterations).toBe(2);
    expect(response.usage).toMatchObject({ input_tokens: 22, output_tokens: 6 });
    expect(response.model_execution).toEqual({
      source: 'provider',
      requested_provider: 'anthropic',
      requested_model: 'claude-sonnet-5',
      provider: 'anthropic',
      model: 'claude-sonnet-5-20260801',
      model_resolution: 'provider_canonicalized',
      fallback_reason: null,
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
    expect(mocks.createMessage.mock.calls[0][0]).toMatchObject({
      max_tokens: 16_384,
      output_config: { effort: 'medium' },
    });
    expect(mocks.createMessage.mock.calls[1][0]).toMatchObject({
      max_tokens: 8_192,
      output_config: { effort: 'medium' },
    });
    expect(mocks.createMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it('recovers once from a wholly empty initial streaming response', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeEmptyStream())
      .mockReturnValueOnce(makeStream(recoveredEndTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true, threadId: 'thread-stream-initial-recovered' },
    )) events.push(event);

    const text = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(text).toBe('Issue 42 is open.');
    expect(done?.response.timing?.iterations).toBe(2);
    expect(done?.response.usage).toMatchObject({ input_tokens: 22, output_tokens: 6 });
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[0][0]).toMatchObject({
      max_tokens: 32_768,
      output_config: { effort: 'medium' },
    });
    expect(mocks.streamMessage.mock.calls[1][0]).toMatchObject({
      max_tokens: 8_192,
      output_config: { effort: 'medium' },
    });
    expect(mocks.streamMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it.each([
    ['thinking-only', thinkingOnlyEndTurn],
    ['redacted-thinking-only', redactedThinkingOnlyEndTurn],
    ['blank text', blankTextEndTurn],
    ['ritual-only text', ritualOnlyEndTurn],
  ])('recovers once from a side-effect-free %s initial non-streaming response', async (_label, initial) => {
    mocks.createMessage
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(recoveredEndTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe('Issue 42 is open.');
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
    expect(mocks.createMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it('recovers once when a streaming end_turn contains only thinking deltas', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeThinkingDeltaStream())
      .mockReturnValueOnce(makeStream(recoveredEndTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    const emittedText = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(emittedText).toBe('Issue 42 is open.');
    expect(done?.response.text).toBe('Issue 42 is open.');
    expect(done?.response.usage).toMatchObject({ input_tokens: 22, output_tokens: 15 });
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it('charges aggregate initial-recovery usage once per streaming and non-streaming interaction', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(recoveredEndTurn);
    mocks.streamMessage
      .mockReturnValueOnce(makeEmptyStream())
      .mockReturnValueOnce(makeStream(recoveredEndTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { costScope: { userId: 'user-nonstream', tier: 'member_paid' } },
    );
    for await (const _event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { costScope: { userId: 'user-stream', tier: 'member_paid' } },
    )) {
      // Consume the complete response so terminal billing runs.
    }

    expect(mocks.recordCost).toHaveBeenCalledTimes(2);
    expect(mocks.recordCost).toHaveBeenNthCalledWith(
      1,
      'user-nonstream',
      'claude-sonnet-5',
      expect.objectContaining({ input_tokens: 22, output_tokens: 6 }),
    );
    expect(mocks.recordCost).toHaveBeenNthCalledWith(
      2,
      'user-stream',
      'claude-sonnet-5',
      expect.objectContaining({ input_tokens: 22, output_tokens: 6 }),
    );
  });

  it('recovers once when a streaming end_turn contains only whitespace text', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(blankTextEndTurn))
      .mockReturnValueOnce(makeStream(recoveredEndTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe('Issue 42 is open.');
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
  });

  it('recovers once when streaming text is entirely removed by postprocessing', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(ritualOnlyEndTurn))
      .mockReturnValueOnce(makeStream(recoveredEndTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    const emittedText = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(emittedText).toBe('Issue 42 is open.');
    expect(done?.response.text).toBe('Issue 42 is open.');
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it('does not resample a wholly empty evaluation response', async () => {
    mocks.createMessage.mockResolvedValueOnce(emptyEndTurn);
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true, executionMode: 'evaluation' },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(mocks.createMessage).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it('does not resample a thinking-only evaluation response', async () => {
    mocks.createMessage.mockResolvedValueOnce(thinkingOnlyEndTurn);
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true, executionMode: 'evaluation' },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(mocks.createMessage).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it('rejects an end_turn containing a tool block without dispatching it', async () => {
    mocks.createMessage.mockResolvedValueOnce(toolBlockEndTurn);
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    await expect(client.processMessage(
      'hello',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true },
    )).rejects.toThrow('incompatible finish reason');

    expect(mocks.createMessage).toHaveBeenCalledOnce();
    expect(getGithubIssue).not.toHaveBeenCalled();
  });

  it('does not resample a streaming end_turn containing a tool block', async () => {
    mocks.streamMessage.mockReturnValueOnce(makeStream(toolBlockEndTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      githubIssueTools,
      { uncapped: true },
    )) events.push(event);

    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(mocks.streamMessage).toHaveBeenCalledOnce();
    expect(getGithubIssue).not.toHaveBeenCalled();
  });

  it('never resamples an empty refusal', async () => {
    mocks.createMessage.mockResolvedValueOnce(emptyRefusal);
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(mocks.createMessage).toHaveBeenCalledOnce();
  });

  it('never resamples an empty streaming refusal', async () => {
    mocks.streamMessage.mockReturnValueOnce(makeStream(emptyRefusal));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(mocks.streamMessage).toHaveBeenCalledOnce();
  });

  it('never resamples an empty refusal after a non-streaming tool call', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(emptyRefusal);
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
  });

  it('never resamples an empty streaming refusal after a tool call', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(toolUseTurn))
      .mockReturnValueOnce(makeStream(emptyRefusal));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'check issue 42',
      undefined,
      githubIssueTools,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
  });

  it('falls back to the first empty terminal when non-streaming recovery fails', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(emptyEndTurn)
      .mockRejectedValueOnce(Object.assign(new Error('recovery transport failed'), { status: 529 }));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'hello',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(response.usage).toMatchObject({ input_tokens: 10, output_tokens: 0 });
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
    expect(mocks.createMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.notifySystemError).toHaveBeenCalledOnce();
  });

  it('falls back to the first empty terminal when streaming recovery fails', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeEmptyStream())
      .mockReturnValueOnce(makeThrowingStream(new Error('recovery stream failed')));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(done?.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 0 });
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.notifySystemError).toHaveBeenCalledOnce();
  });

  it('does not resample when streaming deltas contain text but the final content is empty', async () => {
    mocks.streamMessage.mockReturnValueOnce(makeTextDeltaStreamWithEmptyFinal('A complete answer.'));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'hello',
      undefined,
      undefined,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe('A complete answer.');
    expect(mocks.streamMessage).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
  });

  it('allows one tool call after recovering from a wholly empty initial response', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(recoveredEndTurn);
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe('Issue 42 is open.');
    expect(response.timing?.iterations).toBe(3);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.createMessage).toHaveBeenCalledTimes(3);
    expect(mocks.createMessage.mock.calls[1][0].tools).not.toEqual([]);
    expect(mocks.createMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.createMessage.mock.calls[2][1]).toEqual({ maxRetries: 2 });
  });

  it('restores normal streaming dispatch after initial recovery emits a tool call', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeEmptyStream())
      .mockReturnValueOnce(makeStream(toolUseTurn))
      .mockReturnValueOnce(makeStream(recoveredEndTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'check issue 42',
      undefined,
      githubIssueTools,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe('Issue 42 is open.');
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.streamMessage).toHaveBeenCalledTimes(3);
    expect(mocks.streamMessage.mock.calls[1][1]).toEqual({ maxRetries: 0 });
    expect(mocks.streamMessage.mock.calls[2][1]).toBeUndefined();
  });

  it('recovers ritual-only text after tool use in both paths', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(ritualOnlyEndTurn)
      .mockResolvedValueOnce(recoveredEndTurn);
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(toolUseTurn))
      .mockReturnValueOnce(makeStream(ritualOnlyEndTurn))
      .mockReturnValueOnce(makeStream(recoveredEndTurn));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');

    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true },
    );
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'check issue 42',
      undefined,
      githubIssueTools,
      { uncapped: true },
    )) events.push(event);
    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );

    expect(response.text).toBe('Issue 42 is open.');
    expect(done?.response.text).toBe('Issue 42 is open.');
    expect(getGithubIssue).toHaveBeenCalledTimes(2);
    expect(mocks.createMessage).toHaveBeenCalledTimes(3);
    expect(mocks.streamMessage).toHaveBeenCalledTimes(3);
    expect(mocks.createMessage.mock.calls[2][0].tools).toEqual([]);
    expect(mocks.streamMessage.mock.calls[2][0].tools).toEqual([]);
  });

  it('resamples once after a tool returns an empty non-streaming completion', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(recoveredEndTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true, threadId: 'thread-recovered' },
    );

    expect(response.text).toBe('Issue 42 is open.');
    expect(response.timing?.iterations).toBe(3);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
    expect(mocks.createMessage.mock.calls[2][1]).toEqual({ maxRetries: 0 });
  });

  it('does not discard server-managed search results by entering custom-tool recovery', async () => {
    mocks.createMessage.mockResolvedValueOnce(webSearchResultOnlyEndTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'search for issue 42',
      undefined,
      undefined,
      undefined,
      { uncapped: true, threadId: 'thread-web-search-empty' },
    );

    expect(response.text).toBe('Web search completed (0 results)');
    expect(response.tool_executions[0]?.normalized_result).toMatchObject({
      status: 'empty',
      source: 'structured',
    });
    expect(mocks.createMessage).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).toHaveBeenCalledOnce();
  });

  it('resamples once after a tool returns an empty streaming completion', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(toolUseTurn))
      .mockReturnValueOnce(makeStream(emptyEndTurn))
      .mockReturnValueOnce(makeStream(recoveredEndTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'check issue 42',
      undefined,
      githubIssueTools,
      { uncapped: true, threadId: 'thread-stream-recovered' },
    )) {
      events.push(event);
    }

    const text = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map(event => event.text)
      .join('');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(text).toBe('Issue 42 is open.');
    expect(done?.response.text).toBe('Issue 42 is open.');
    expect(done?.response.timing?.iterations).toBe(3);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).not.toHaveBeenCalled();
    expect(mocks.streamMessage.mock.calls[2][1]).toEqual({ maxRetries: 0 });
  });

  it('falls back without retrying when post-tool recovery transport fails', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(emptyEndTurn)
      .mockRejectedValueOnce(Object.assign(new Error('recovery overloaded'), { status: 529 }));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(response.usage).toMatchObject({ input_tokens: 20, output_tokens: 5 });
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.createMessage).toHaveBeenCalledTimes(3);
    expect(mocks.createMessage.mock.calls[2][1]).toEqual({ maxRetries: 0 });
  });

  it('falls back after the one non-streaming post-tool resample is also empty', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(emptyEndTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true, threadId: 'thread-recovery-exhausted' },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(response.flagged).toBe(true);
    expect(response.timing?.iterations).toBe(3);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.createMessage).toHaveBeenCalledTimes(3);
    expect(mocks.createMessage.mock.calls[2][0].tools).toEqual([]);
    expect(mocks.notifySystemError).toHaveBeenCalledOnce();
  });

  it('falls back after the one streaming post-tool resample is also empty', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(toolUseTurn))
      .mockReturnValueOnce(makeStream(emptyEndTurn))
      .mockReturnValueOnce(makeStream(emptyEndTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'check issue 42',
      undefined,
      githubIssueTools,
      { uncapped: true, threadId: 'thread-stream-recovery-exhausted' },
    )) {
      events.push(event);
    }

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(done?.response.flagged).toBe(true);
    expect(done?.response.timing?.iterations).toBe(3);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.streamMessage).toHaveBeenCalledTimes(3);
    expect(mocks.streamMessage.mock.calls[2][0].tools).toEqual([]);
    expect(mocks.notifySystemError).toHaveBeenCalledOnce();
  });

  it('uses the normalized search summary as the non-streaming web fallback', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(searchToolUseTurn)
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(emptyEndTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'find missing term',
      undefined,
      searchDocsTools,
      undefined,
      { uncapped: true, threadId: 'thread-search-fallback' },
    );

    expect(response.text).toBe('No documentation found in AdCP 3.2-beta for: "missing term"');
    expect(response.tool_executions[0]).toMatchObject({
      tool_name: 'search_docs',
      is_error: false,
      normalized_result: {
        status: 'empty',
        source: 'classified',
        user_summary: 'No documentation found in AdCP 3.2-beta for: "missing term"',
      },
    });
    expect(searchDocs).toHaveBeenCalledOnce();
  });

  it('uses the same normalized search summary as the streaming Slack fallback', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(searchToolUseTurn))
      .mockReturnValueOnce(makeStream(emptyEndTurn))
      .mockReturnValueOnce(makeStream(emptyEndTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'find missing term',
      undefined,
      searchDocsTools,
      { uncapped: true, threadId: 'thread-stream-search-fallback' },
    )) events.push(event);

    const text = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    const toolEnd = events.find(
      (event): event is Extract<StreamEvent, { type: 'tool_end' }> => event.type === 'tool_end',
    );
    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );

    expect(text).toBe('No documentation found in AdCP 3.2-beta for: "missing term"');
    expect(done?.response.text).toBe(text);
    expect(toolEnd?.normalized_result).toMatchObject({ status: 'empty', source: 'classified' });
    expect(searchDocs).toHaveBeenCalledOnce();
  });

  it('never repeats a tool emitted by a malformed non-streaming recovery response', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(emptyEndTurn)
      .mockResolvedValueOnce(mixedRecoveryToolUseTurn);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const response = await client.processMessage(
      'check issue 42',
      undefined,
      githubIssueTools,
      undefined,
      { uncapped: true, threadId: 'thread-recovery-tool-rejected' },
    );

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(response.text).not.toContain('updated it again');
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).toHaveBeenCalledOnce();
  });

  it('never repeats a tool emitted by a malformed streaming recovery response', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(makeStream(toolUseTurn))
      .mockReturnValueOnce(makeStream(emptyEndTurn))
      .mockReturnValueOnce(makeStream(mixedRecoveryToolUseTurn));

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'check issue 42',
      undefined,
      githubIssueTools,
      { uncapped: true, threadId: 'thread-stream-recovery-tool-rejected' },
    )) {
      events.push(event);
    }

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    const streamedText = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(streamedText).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
    expect(getGithubIssue).toHaveBeenCalledOnce();
    expect(mocks.notifySystemError).toHaveBeenCalledOnce();
  });
});
