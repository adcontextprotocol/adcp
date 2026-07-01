import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Mid-stream upstream-failure event surface (#4797).
 *
 * When Anthropic's streaming API errors after deltas have already shipped
 * to the user, `processMessageStream` must yield a `stream_error` event
 * before the underlying error throws — so consumers (Slack via bolt-app,
 * web via addie-chat, voice via tavus) can render a recovery banner and
 * drop the partial assistant turn from conversation history.
 *
 * The "no retry after content yielded" guard in claude-client.ts is
 * load-bearing: Anthropic streaming has no resumption token and the
 * prompt cache only dedupes input, so a retried request would sample a
 * fresh output and we'd be stitching two unrelated streams. The event
 * gives the consumer the signal needed to do the discard cleanly.
 */

// Two stream stubs covering both realistic mid-stream failure shapes.
//
// Production sees either:
// 1. A keyword-only Error (e.g. when the underlying SDK has already
//    unwrapped to a generic error) — matches the line-103 fallback in
//    `isRetryableError`.
// 2. An SDK `APIError` carrying an SSE-body `{ error: { type:
//    'overloaded_error' } }` and `status: undefined` (streaming errors
//    arrive inside an HTTP 200) — matches the line-95-99 path in
//    `isRetryableError`. This is the load-bearing branch in prod.
function makeKeywordErrorStub() {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Sure, the answer is ' },
      };
      throw new Error("overloaded_error: Anthropic API is overloaded");
    },
    finalMessage: vi.fn().mockResolvedValue(null),
  };
}

function makeApiErrorStub(MockedAPIError: { new (msg: string): Error & { status?: number; error?: unknown } }) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Sure, the answer is ' },
      };
      const apiErr = new MockedAPIError("Streaming error");
      apiErr.status = undefined;
      apiErr.error = { type: 'overloaded_error', message: 'overloaded' };
      throw apiErr;
    },
    finalMessage: vi.fn().mockResolvedValue(null),
  };
}

// Selects which stub the mocked SDK returns. Mutated per-test below.
let streamStubFactory: () => ReturnType<typeof makeKeywordErrorStub> = makeKeywordErrorStub;

vi.mock('@anthropic-ai/sdk', () => {
  class MockAPIError extends Error {
    status?: number;
    error?: unknown;
    constructor(msg: string) { super(msg); this.name = 'APIError'; }
  }
  class MockAPIConnectionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'APIConnectionError'; }
  }
  return {
    default: class {
      beta = {
        messages: {
          stream: vi.fn(() => streamStubFactory()),
          create: vi.fn(),
        },
      };
      messages = {
        create: vi.fn(),
        stream: vi.fn(() => streamStubFactory()),
      };
    },
    APIError: MockAPIError,
    APIConnectionError: MockAPIConnectionError,
  };
});

import { AddieClaudeClient, type StreamEvent } from '../../src/addie/claude-client.js';
import {
  __setCostTrackerStore,
  __createInMemoryCostStore,
} from '../../src/addie/claude-cost-tracker.js';

beforeEach(() => {
  __setCostTrackerStore(__createInMemoryCostStore());
  // Default stub: keyword-only Error. Per-test overrides flip to APIError.
  streamStubFactory = makeKeywordErrorStub;
});

describe('processMessageStream — mid-stream upstream failure (#4797)', () => {
  it('yields a stream_error event with deltasBeforeError before the underlying error throws', async () => {
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'tell me about X',
      undefined,
      undefined,
      { costScope: { userId: 'test-user', tier: 'member_paid' }, maxIterations: 1 },
    )) {
      events.push(event);
    }

    // Should have seen the text delta then the stream_error event.
    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect((textEvents[0] as { type: 'text'; text: string }).text).toBe('Sure, the answer is ');

    const streamErrorEvents = events.filter(e => e.type === 'stream_error');
    expect(streamErrorEvents).toHaveLength(1);

    const evt = streamErrorEvents[0] as Extract<StreamEvent, { type: 'stream_error' }>;
    expect(evt.reason).toBe('API is busy');
    expect(evt.deltasBeforeError).toBe(1);

    // The underlying error is wrapped into a final `error` event by
    // processMessageStream's outer catch (claude-client.ts:1730). The
    // consumer-side throw happens in bolt-app's event-loop branch that
    // re-raises on `error`; addie-chat/tavus return/break on the
    // `stream_error` event instead. Either path lands persistence in
    // the discard branch.
    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { type: 'error'; error: string }).error).toMatch(/overloaded/);
  });

  it('orders stream_error after text deltas (consumer can render in-place recovery)', async () => {
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const eventTypes: string[] = [];
    try {
      for await (const event of client.processMessageStream(
        'hi',
        undefined,
        undefined,
        { costScope: { userId: 'test-user-2', tier: 'member_paid' }, maxIterations: 1 },
      )) {
        eventTypes.push(event.type);
      }
    } catch {
      // expected
    }

    const textIdx = eventTypes.indexOf('text');
    const streamErrorIdx = eventTypes.indexOf('stream_error');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(streamErrorIdx).toBeGreaterThan(textIdx);
  });

  it('also fires for the production-shape APIError (SSE-body overloaded_error, status undefined)', async () => {
    // Switch the SDK mock to throw an APIError carrying the SSE-body
    // shape. This is the actual production code path (`isRetryableError`
    // line 95-99 in anthropic-retry.ts), not the line-103 keyword
    // fallback the first test exercises.
    const sdkModule = await import('@anthropic-ai/sdk');
    const MockedAPIError = (sdkModule as unknown as { APIError: new (msg: string) => Error & { status?: number; error?: unknown } }).APIError;
    streamStubFactory = () => makeApiErrorStub(MockedAPIError);

    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const events: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'tell me about Y',
      undefined,
      undefined,
      { costScope: { userId: 'test-user-3', tier: 'member_paid' }, maxIterations: 1 },
    )) {
      events.push(event);
    }

    const streamErrorEvents = events.filter(e => e.type === 'stream_error');
    expect(streamErrorEvents).toHaveLength(1);
    const evt = streamErrorEvents[0] as Extract<StreamEvent, { type: 'stream_error' }>;
    expect(evt.deltasBeforeError).toBe(1);
  });
});
