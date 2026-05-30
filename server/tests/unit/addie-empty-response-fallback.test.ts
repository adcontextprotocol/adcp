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

function makeEmptyStream() {
  return {
    async *[Symbol.asyncIterator]() {
      // No deltas: this is the silent-response failure shape.
    },
    finalMessage: vi.fn().mockResolvedValue(emptyEndTurn),
  };
}

describe('Addie empty-response fallback (#4430)', () => {
  beforeEach(() => {
    mocks.createMessage.mockReset();
    mocks.streamMessage.mockReset();
    mocks.notifySystemError.mockReset();
    mocks.notifyToolError.mockReset();
  });

  it('returns fallback text and sends monitoring for non-streaming empty responses', async () => {
    mocks.createMessage.mockResolvedValueOnce(emptyEndTurn);

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
    expect(mocks.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'addie-empty-response',
      errorMessage: expect.stringContaining('thread-empty'),
    }));
  });

  it('yields fallback text before done for streaming empty responses', async () => {
    mocks.streamMessage.mockReturnValueOnce(makeEmptyStream());

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
    expect(mocks.notifySystemError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'addie-empty-response',
      errorMessage: expect.stringContaining('processMessageStream'),
    }));
  });
});
