import { describe, expect, it, vi } from 'vitest';
import {
  getModelExecutionReadiness,
  summarizeModelExecutionReadiness,
} from '../../../src/addie/model-execution-readiness.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');

function aggregate(surface: 'thread_messages' | 'interactions', overrides: Record<string, string> = {}) {
  return {
    surface,
    total: '100',
    provider: '90',
    local: '10',
    unclassified: '0',
    legacy: '0',
    invalid: '0',
    fallback: '2',
    canonicalized: '3',
    ...overrides,
  };
}

describe('model execution readiness', () => {
  it('marks a fully classified representative window ready', () => {
    const summary = summarizeModelExecutionReadiness([
      aggregate('thread_messages'),
      aggregate('interactions', { total: '5', provider: '5', local: '0' }),
    ], {
      hours: 24,
      minimumSamples: 100,
      now: NOW,
    });

    expect(summary.persisted_data_ready).toBe(true);
    expect(summary.blockers).toEqual([]);
    expect(summary.surfaces.thread_messages.classification_rate).toBe(1);
    expect(summary.surfaces.interactions.classification_rate).toBe(1);
    expect(summary.scope).toBe('persisted_provenance_data');
    expect(summary.limitations).toEqual([
      'requires_deployment_drain_confirmation',
      'does_not_measure_failed_database_writes',
      'not_a_provider_canary_gate',
    ]);
    expect(summary.window).toEqual({
      start: '2026-08-24T12:00:00.000Z',
      end: '2026-08-25T12:00:00.000Z',
      hours: 24,
    });
  });

  it('keeps every provenance failure in the denominator', () => {
    const summary = summarizeModelExecutionReadiness([
      aggregate('thread_messages', {
        total: '12',
        provider: '5',
        local: '2',
        unclassified: '3',
        legacy: '2',
        invalid: '1',
      }),
      aggregate('interactions', { total: '1', provider: '1', local: '0' }),
    ], {
      hours: 12,
      minimumSamples: 20,
      now: NOW,
    });

    expect(summary.surfaces.thread_messages.classification_rate).toBe(7 / 12);
    expect(summary.persisted_data_ready).toBe(false);
    expect(summary.blockers).toEqual([
      { surface: 'thread_messages', reason: 'insufficient_sample_size' },
      { surface: 'thread_messages', reason: 'unclassified_executions' },
      { surface: 'thread_messages', reason: 'legacy_executions' },
      { surface: 'thread_messages', reason: 'invalid_provenance' },
    ]);
  });

  it('blocks when the legacy interaction sink is unclassified without double-counting it', () => {
    const summary = summarizeModelExecutionReadiness([
      aggregate('thread_messages'),
      aggregate('interactions', {
        total: '7', provider: '4', local: '2', unclassified: '1',
      }),
    ], {
      hours: 24,
      minimumSamples: 100,
      now: NOW,
    });

    expect(summary.surfaces.thread_messages.total).toBe(100);
    expect(summary.surfaces.interactions.total).toBe(7);
    expect(summary.persisted_data_ready).toBe(false);
    expect(summary.blockers).toEqual([
      { surface: 'interactions', reason: 'unclassified_executions' },
    ]);
  });

  it('queries an exact half-open window and returns aggregate counts only', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      aggregate('thread_messages', { total: '3', provider: '2', local: '1' }),
      aggregate('interactions', { total: '1', provider: '1', local: '0' }),
    ] });
    const summary = await getModelExecutionReadiness({
      hours: 6,
      minimumSamples: 3,
      now: NOW,
    }, query);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      new Date('2026-08-25T06:00:00.000Z'),
      NOW,
    ]);
    expect(query.mock.calls[0]?.[0]).not.toMatch(/\bcontent\b/);
    expect(query.mock.calls[0]?.[0]).toContain("role IS DISTINCT FROM 'assistant'");
    expect(query.mock.calls[0]?.[0]).toMatch(/role = 'assistant'[\s\S]+model_execution_source IS NOT NULL/);
    expect(query.mock.calls[0]?.[0]).toContain('COUNT(*) FILTER (WHERE included_in_denominator)::text AS total');
    expect(summary.surfaces.thread_messages).toMatchObject({
      total: 3, provider: 2, local: 1, persisted_data_ready: true,
    });
    expect(summary.persisted_data_ready).toBe(true);
  });

  it('fails closed on malformed aggregate counts', () => {
    expect(() => summarizeModelExecutionReadiness([
      aggregate('thread_messages', { total: '12oops' }),
      aggregate('interactions'),
    ], { hours: 24, minimumSamples: 1, now: NOW })).toThrow(
      'Invalid aggregate count for thread_messages.total',
    );
  });

  it('fails closed when a surface aggregate is missing or duplicated', () => {
    expect(() => summarizeModelExecutionReadiness([
      aggregate('thread_messages'),
    ], { hours: 24, minimumSamples: 1, now: NOW })).toThrow(
      'Readiness aggregate must contain exactly one row per surface',
    );
    expect(() => summarizeModelExecutionReadiness([
      aggregate('thread_messages'),
      aggregate('thread_messages'),
    ], { hours: 24, minimumSamples: 1, now: NOW })).toThrow(
      'Readiness aggregate must contain exactly one row per surface',
    );
  });

  it('reports an unobserved interaction sink as inconclusive', () => {
    const summary = summarizeModelExecutionReadiness([
      aggregate('thread_messages'),
      aggregate('interactions', { total: '0', provider: '0', local: '0' }),
    ], { hours: 24, minimumSamples: 100, now: NOW });

    expect(summary.surfaces.interactions).toMatchObject({
      total: 0,
      persisted_data_ready: false,
      blockers: ['insufficient_sample_size'],
    });
    expect(summary.blockers).toContainEqual({
      surface: 'interactions',
      reason: 'insufficient_sample_size',
    });
  });

  it.each([
    [{ hours: 0 }, 'hours must be an integer from 1 to 168'],
    [{ hours: 1.5 }, 'hours must be an integer from 1 to 168'],
    [{ hours: 169 }, 'hours must be an integer from 1 to 168'],
    [{ minimumSamples: 0 }, 'minimumSamples must be an integer from 1 to 10000'],
    [{ minimumSamples: 10_001 }, 'minimumSamples must be an integer from 1 to 10000'],
    [{ now: new Date('invalid') }, 'now must be a valid date'],
  ])('rejects invalid options before querying: %j', async (options, message) => {
    const query = vi.fn();
    await expect(getModelExecutionReadiness(options, query)).rejects.toThrow(message);
    expect(query).not.toHaveBeenCalled();
  });
});
