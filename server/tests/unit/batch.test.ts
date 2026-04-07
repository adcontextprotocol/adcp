import { describe, it, expect, vi, beforeEach } from 'vitest';
import { submitBatch, extractText } from '../../src/utils/batch.js';
import type { BatchItemResult } from '../../src/utils/batch.js';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Tests for the batch processing utility.
 *
 * Mocks the Anthropic SDK batch methods since we're testing our
 * orchestration logic (submission, polling, result collection),
 * not the Anthropic API itself.
 */

function makeClient(overrides: {
  create?: ReturnType<typeof vi.fn>;
  retrieve?: ReturnType<typeof vi.fn>;
  results?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    messages: {
      batches: {
        create: overrides.create ?? vi.fn(),
        retrieve: overrides.retrieve ?? vi.fn(),
        results: overrides.results ?? vi.fn(),
        cancel: vi.fn(),
      },
    },
  } as unknown as Anthropic;
}

function makeSucceededEntry(customId: string, text: string) {
  return {
    custom_id: customId,
    result: {
      type: 'succeeded' as const,
      message: {
        content: [{ type: 'text' as const, text }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    },
  };
}

function makeErroredEntry(customId: string) {
  return {
    custom_id: customId,
    result: {
      type: 'errored' as const,
      error: {
        type: 'error',
        error: { type: 'server_error', message: 'Internal error' },
        request_id: null,
      },
    },
  };
}

function makeExpiredEntry(customId: string) {
  return {
    custom_id: customId,
    result: { type: 'expired' as const },
  };
}

function makeCanceledEntry(customId: string) {
  return {
    custom_id: customId,
    result: { type: 'canceled' as const },
  };
}

function makeRequest(customId: string) {
  return {
    customId,
    params: {
      model: 'claude-haiku-4-5' as const,
      max_tokens: 100,
      messages: [{ role: 'user' as const, content: customId }],
    },
  };
}

/** Simulate an async iterable of JSONL results */
async function* asyncIterableOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

describe('submitBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty map for empty requests', async () => {
    const client = makeClient();
    const results = await submitBatch(client, []);
    expect(results.size).toBe(0);
    expect(client.messages.batches.create).not.toHaveBeenCalled();
  });

  it('submits requests and collects succeeded results', async () => {
    const entries = [
      makeSucceededEntry('req-1', 'Response one'),
      makeSucceededEntry('req-2', 'Response two'),
    ];

    const client = makeClient({
      create: vi.fn().mockResolvedValue({
        id: 'batch-123',
        processing_status: 'in_progress',
        request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'batch-123',
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
      }),
      results: vi.fn().mockResolvedValue(asyncIterableOf(entries)),
    });

    const results = await submitBatch(
      client,
      [
        { customId: 'req-1', params: { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] } },
        { customId: 'req-2', params: { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'World' }] } },
      ],
      { pollIntervalMs: 1, operationName: 'test' },
    );

    expect(results.size).toBe(2);
    expect(results.get('req-1')?.status).toBe('succeeded');
    expect(results.get('req-2')?.status).toBe('succeeded');

    // Verify batch was created with correct custom_ids
    const createCall = (client.messages.batches.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.requests).toHaveLength(2);
    expect(createCall.requests[0].custom_id).toBe('req-1');
    expect(createCall.requests[1].custom_id).toBe('req-2');
  });

  it('handles mixed results (succeeded, errored, expired)', async () => {
    const entries = [
      makeSucceededEntry('ok', 'Good response'),
      makeErroredEntry('bad'),
      makeExpiredEntry('late'),
    ];

    const client = makeClient({
      create: vi.fn().mockResolvedValue({ id: 'batch-456', processing_status: 'in_progress' }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'batch-456',
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 1 },
      }),
      results: vi.fn().mockResolvedValue(asyncIterableOf(entries)),
    });

    const results = await submitBatch(
      client,
      [
        { customId: 'ok', params: { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'a' }] } },
        { customId: 'bad', params: { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'b' }] } },
        { customId: 'late', params: { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'c' }] } },
      ],
      { pollIntervalMs: 1 },
    );

    expect(results.get('ok')?.status).toBe('succeeded');
    expect(results.get('bad')?.status).toBe('errored');
    expect(results.get('bad')?.error?.type).toBe('server_error');
    expect(results.get('late')?.status).toBe('expired');
  });

  it('polls multiple times until batch ends', async () => {
    const retrieve = vi.fn()
      .mockResolvedValueOnce({
        id: 'batch-789',
        processing_status: 'in_progress',
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      })
      .mockResolvedValueOnce({
        id: 'batch-789',
        processing_status: 'in_progress',
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      })
      .mockResolvedValueOnce({
        id: 'batch-789',
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
      });

    const client = makeClient({
      create: vi.fn().mockResolvedValue({ id: 'batch-789', processing_status: 'in_progress' }),
      retrieve,
      results: vi.fn().mockResolvedValue(asyncIterableOf([makeSucceededEntry('r1', 'done')])),
    });

    const results = await submitBatch(
      client,
      [{ customId: 'r1', params: { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] } }],
      { pollIntervalMs: 1 },
    );

    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(results.get('r1')?.status).toBe('succeeded');
  });

  it('cancels batch and throws on timeout', async () => {
    const client = makeClient({
      create: vi.fn().mockResolvedValue({ id: 'batch-slow', processing_status: 'in_progress' }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'batch-slow',
        processing_status: 'in_progress',
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      }),
    });

    await expect(
      submitBatch(client, [makeRequest('r1')], { pollIntervalMs: 1, timeoutMs: 50 }),
    ).rejects.toThrow('timed out');

    expect(client.messages.batches.cancel).toHaveBeenCalledWith('batch-slow');
  });

  it('throws wrapped error when create() rejects', async () => {
    const client = makeClient({
      create: vi.fn().mockRejectedValue(new Error('rate_limit_error')),
    });

    await expect(
      submitBatch(client, [makeRequest('r1')], { operationName: 'test-op' }),
    ).rejects.toThrow('Batch submission failed for test-op: rate_limit_error');
  });

  it('throws when retrieve() fails mid-poll', async () => {
    const retrieve = vi.fn()
      .mockResolvedValueOnce({
        id: 'batch-net',
        processing_status: 'in_progress',
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      })
      .mockRejectedValueOnce(new Error('Connection reset'));

    const client = makeClient({
      create: vi.fn().mockResolvedValue({ id: 'batch-net', processing_status: 'in_progress' }),
      retrieve,
    });

    await expect(
      submitBatch(client, [makeRequest('r1')], { pollIntervalMs: 1 }),
    ).rejects.toThrow('Connection reset');
  });

  it('throws when batch size exceeds API limit', async () => {
    const client = makeClient();
    const requests = Array.from({ length: 100_001 }, (_, i) => makeRequest(`r-${i}`));

    await expect(submitBatch(client, requests)).rejects.toThrow('exceeds API limit');
    expect(client.messages.batches.create).not.toHaveBeenCalled();
  });

  it('handles canceled result type', async () => {
    const entries = [
      makeSucceededEntry('ok', 'Good'),
      makeCanceledEntry('stopped'),
    ];

    const client = makeClient({
      create: vi.fn().mockResolvedValue({ id: 'batch-c', processing_status: 'in_progress' }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'batch-c',
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 1, expired: 0 },
      }),
      results: vi.fn().mockResolvedValue(asyncIterableOf(entries)),
    });

    const results = await submitBatch(
      client,
      [makeRequest('ok'), makeRequest('stopped')],
      { pollIntervalMs: 1 },
    );

    expect(results.get('ok')?.status).toBe('succeeded');
    expect(results.get('stopped')?.status).toBe('canceled');
  });

  it('still throws timeout error when cancel() itself fails', async () => {
    const client = makeClient({
      create: vi.fn().mockResolvedValue({ id: 'batch-cf', processing_status: 'in_progress' }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'batch-cf',
        processing_status: 'in_progress',
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      }),
    });
    (client.messages.batches.cancel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('batch already ended'),
    );

    await expect(
      submitBatch(client, [makeRequest('r1')], { pollIntervalMs: 1, timeoutMs: 50 }),
    ).rejects.toThrow('timed out');
  });
});

describe('extractText', () => {
  it('extracts text from a succeeded result', () => {
    const result: BatchItemResult = {
      customId: 'test',
      status: 'succeeded',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      } as Anthropic.Message,
    };
    expect(extractText(result)).toBe('Hello world');
  });

  it('returns null for errored result', () => {
    const result: BatchItemResult = {
      customId: 'test',
      status: 'errored',
      error: { type: 'server_error', message: 'fail' },
    };
    expect(extractText(result)).toBeNull();
  });

  it('returns null for undefined result', () => {
    expect(extractText(undefined)).toBeNull();
  });

  it('returns null for message with no text blocks', () => {
    const result: BatchItemResult = {
      customId: 'test',
      status: 'succeeded',
      message: { content: [] } as unknown as Anthropic.Message,
    };
    expect(extractText(result)).toBeNull();
  });

  it('joins multiple text blocks', () => {
    const result: BatchItemResult = {
      customId: 'test',
      status: 'succeeded',
      message: {
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
      } as Anthropic.Message,
    };
    expect(extractText(result)).toBe('Line 1\nLine 2');
  });

  it('filters out non-text content blocks', () => {
    const result: BatchItemResult = {
      customId: 'test',
      status: 'succeeded',
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'tu_1', name: 'foo', input: {} },
          { type: 'text', text: 'World' },
        ],
      } as unknown as Anthropic.Message,
    };
    expect(extractText(result)).toBe('Hello\nWorld');
  });
});
