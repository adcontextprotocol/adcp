import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { AddieDatabase } from '../../src/db/addie-db.js';
import { query } from '../../src/db/client.js';

const queryMock = vi.mocked(query);

function providerInteraction() {
  return {
    id: 'usage-provider',
    timestamp: new Date('2026-09-01T00:00:00.000Z'),
    event_type: 'dm' as const,
    channel_id: 'D_TEST',
    user_id: 'U_TEST',
    input_text: 'question',
    input_sanitized: 'question',
    output_text: 'answer',
    tools_used: [],
    model: 'claude-sonnet-5',
    model_execution: {
      source: 'provider' as const,
      requested_provider: 'anthropic' as const,
      requested_model: 'claude-sonnet-5',
      provider: 'anthropic' as const,
      model: 'claude-sonnet-5',
      model_resolution: 'exact' as const,
      fallback_reason: null,
    },
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      cacheWriteTokens: 3,
      cacheReadTokens: 2,
    },
    latency_ms: 10,
    flagged: false,
  };
}

describe('AddieDatabase interaction usage persistence', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('writes normalized token and cache usage with provider provenance', async () => {
    await new AddieDatabase().logInteraction(providerInteraction());

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain(
      'tokens_input, tokens_output, tokens_cache_creation, tokens_cache_read',
    );
    expect(params?.slice(19, 23)).toEqual([12, 4, 3, 2]);
  });

  it('rejects provider provenance without normalized usage before persistence', async () => {
    await expect(new AddieDatabase().logInteraction({
      ...providerInteraction(),
      usage: null,
    })).rejects.toThrow('Provider interaction requires normalized usage');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('round-trips measured zero while preserving unavailable cache metrics', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'usage-zero',
        event_type: 'dm',
        channel_id: 'D_TEST',
        thread_ts: null,
        user_id: 'U_TEST',
        input_text: 'question',
        input_sanitized: 'question',
        output_text: 'answer',
        tools_used: [],
        model: 'claude-sonnet-5',
        model_execution_source: 'provider',
        requested_model_provider: 'anthropic',
        requested_model: 'claude-sonnet-5',
        model_provider: 'anthropic',
        provider_model: 'claude-sonnet-5',
        provider_model_resolution: 'exact',
        provider_fallback_reason: null,
        local_response_reason: null,
        tokens_input: 0,
        tokens_output: 0,
        tokens_cache_creation: null,
        tokens_cache_read: null,
        latency_ms: 10,
        flagged: false,
        flag_reason: null,
        created_at: new Date('2026-09-01T00:00:00.000Z'),
      }],
      rowCount: 1,
    } as never);

    const [interaction] = await new AddieDatabase().getInteractions();
    expect(interaction.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
