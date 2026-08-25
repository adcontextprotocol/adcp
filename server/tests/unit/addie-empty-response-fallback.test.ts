import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
  notifySystemError: vi.fn(),
  notifyToolError: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        create: mocks.createMessage,
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

import {
  ADDIE_EMPTY_RESPONSE_FALLBACK,
  AddieClaudeClient,
  type StreamEvent,
} from '../../src/addie/claude-client.js';

const emptyEndTurn = {
  stop_reason: 'end_turn',
  content: [],
  usage: {
    input_tokens: 10,
    output_tokens: 0,
  },
};

const toolUseTurn = {
  stop_reason: 'tool_use',
  content: [{
    type: 'tool_use',
    id: 'toolu_1',
    name: 'get_github_issue',
    input: { issue_number: 42 },
  }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

const recoveredEndTurn = {
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'Issue 42 is open.' }],
  usage: { input_tokens: 12, output_tokens: 6 },
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

function makeThrowingStream(error: Error) {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    finalMessage: vi.fn(),
  };
}

function makeStream(message: typeof toolUseTurn | typeof emptyEndTurn | typeof recoveredEndTurn | typeof mixedRecoveryToolUseTurn | typeof emptyRefusal) {
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

describe('Addie empty-response fallback (#4430)', () => {
  beforeEach(() => {
    mocks.createMessage.mockReset();
    mocks.streamMessage.mockReset();
    mocks.notifySystemError.mockReset();
    mocks.notifyToolError.mockReset();
    getGithubIssue.mockClear();
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
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'addie-empty-response',
      errorMessage: expect.stringContaining('processMessageStream'),
    }));
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
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
    expect(mocks.createMessage.mock.calls[0][0]).toMatchObject({
      max_tokens: 16_384,
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
      max_tokens: 16_384,
      output_config: { effort: 'medium' },
    });
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
    expect(mocks.createMessage.mock.calls[2][1]).toBeUndefined();
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

    expect(response.text).toBe(ADDIE_EMPTY_RESPONSE_FALLBACK);
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
