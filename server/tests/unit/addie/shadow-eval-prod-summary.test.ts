import { describe, expect, it } from 'vitest';
import {
  aggregate,
  type ThreadSummary,
} from '../../manual/shadow-eval-prod-summary.js';

function row(context: NonNullable<ThreadSummary['context']>): ThreadSummary {
  return { thread_id: crypto.randomUUID(), context };
}

describe('shadow evaluation production summary', () => {
  it('counts errors and invalid evaluations in the attempt denominator', () => {
    const result = aggregate([
      row({
        shadow_eval_status: 'error',
        shadow_eval_type: 'suppressed_opportunity',
      }),
      row({
        shadow_eval_status: 'complete',
        shadow_eval_type: 'corrected_answer',
        shadow_eval_result: { evaluation_valid: false },
      }),
    ]);

    expect(result.total).toBe(2);
    expect(result.completed).toBe(0);
    expect(result.invalid_evaluations_by_type).toEqual({
      suppressed_opportunity: 1,
      corrected_answer: 1,
    });
  });

  it('reports over-bound evidence as skipped rather than invalid', () => {
    const result = aggregate([
      row({
        shadow_eval_status: 'skipped',
        shadow_eval_type: 'corrected_answer',
        shadow_eval_result: {
          evaluation_valid: false,
          evaluation_skipped: true,
          evaluation_error: 'comparison_input_too_long',
        },
      }),
    ]);

    expect(result.total).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.skipped_evaluations_by_type).toEqual({ corrected_answer: 1 });
    expect(result.invalid_evaluations_by_type).toEqual({});
  });

  it('keeps descriptions-only and self-judged rows out of headline metrics', () => {
    const result = aggregate([
      row({
        shadow_eval_status: 'complete',
        shadow_eval_type: 'suppressed_opportunity',
        shadow_eval_result: { evaluation_valid: true, knowledge_gap: true },
        shadow_eval_provenance: {
          self_judged: false,
          source_answer: { model: 'claude-production', config_version_id: 42 },
          source_opportunity: { config_version_id: 42 },
          tools: { mode: 'descriptions_only' },
        },
      }),
      row({
        shadow_eval_status: 'complete',
        shadow_eval_type: 'corrected_answer',
        shadow_eval_result: { evaluation_valid: true, knowledge_gap: true },
        shadow_eval_provenance: {
          self_judged: true,
          source_answer: { model: 'claude-production', config_version_id: 42 },
          tools: { mode: 'production_trace', trace_or_fixture_id: 'message-1' },
        },
      }),
    ]);

    expect(result.completed).toBe(2);
    expect(result.eligible_total).toBe(0);
    expect(result.knowledge_gaps_by_type).toEqual({});
    expect(result.provenance_excluded_by_type).toEqual({
      suppressed_opportunity: 1,
      corrected_answer: 1,
    });
  });

  it('fails closed for unsigned production-trace labels in mutable context', () => {
    const result = aggregate([
      row({
        shadow_eval_status: 'complete',
        shadow_eval_type: 'corrected_answer',
        shadow_eval_result: {
          evaluation_valid: true,
          knowledge_gap: true,
          gap_severity: 'significant',
        },
        shadow_eval_provenance: {
          self_judged: false,
          source_answer: { model: 'claude-production', config_version_id: 42 },
          tools: { mode: 'production_trace', trace_or_fixture_id: 'message-1' },
        },
        shadow_eval_shape: {
          shadow: { word_count: 200, violations: ['length_cap'], ratio_to_expected: 2 },
        },
      }),
    ]);

    expect(result.eligible_total).toBe(0);
    expect(result.eligible_by_type).toEqual({});
    expect(result.knowledge_gaps_by_type).toEqual({});
    expect(result.provenance_excluded_by_type).toEqual({ corrected_answer: 1 });
    expect(result.questions_with_any_violation).toBe(0);
  });

  it('excludes incomplete source provenance from headline metrics', () => {
    const result = aggregate([
      row({
        shadow_eval_status: 'complete',
        shadow_eval_type: 'corrected_answer',
        shadow_eval_result: { evaluation_valid: true, knowledge_gap: false },
        shadow_eval_provenance: {
          self_judged: false,
          tools: { mode: 'production_trace' },
        },
      }),
    ]);

    expect(result.eligible_total).toBe(0);
    expect(result.provenance_excluded_by_type).toEqual({ corrected_answer: 1 });
  });

  it('reports structural replay outcomes without trusting mutable headline authorization', () => {
    const base = {
      shadow_eval_status: 'complete',
      shadow_eval_type: 'suppressed_opportunity',
      shadow_eval_result: { evaluation_valid: true, knowledge_gap: false },
    } as const;
    const result = aggregate([
      row({
        ...base,
        shadow_eval_provenance: {
          self_judged: false,
          source_answer: { model: 'claude-production', config_version_id: 42 },
          tools: {
            mode: 'read_only_replay',
            trace_or_fixture_id: 'replay-complete',
            policy_version: 'read-only-v1',
            complete_fidelity: true,
            blocked_capabilities: [],
            hash_key_version: 'test-key-v1',
            trace_verified: true,
            system_block_hashes: ['system-hash'],
            schemas: [{ name: 'search_docs' }],
          },
          source_opportunity: { config_version_id: 42 },
        },
      }),
      row({
        ...base,
        shadow_eval_provenance: {
          self_judged: false,
          source_answer: { model: 'claude-production', config_version_id: 42 },
          tools: {
            mode: 'read_only_replay',
            trace_or_fixture_id: 'replay-blocked',
            policy_version: 'read-only-v1',
            complete_fidelity: false,
            blocked_capabilities: ['mutation:publish_example'],
            hash_key_version: 'test-key-v1',
            trace_verified: false,
            system_block_hashes: ['system-hash'],
            schemas: [{ name: 'publish_example' }],
          },
          source_opportunity: { config_version_id: 42 },
        },
      }),
    ]);

    expect(result.eligible_total).toBe(0);
    expect(result.replay_fidelity).toEqual({ complete: 1, incomplete: 1 });
    expect(result.blocked_capability_counts).toEqual({ mutation: 1 });
    expect(result.provenance_excluded_by_type).toEqual({ suppressed_opportunity: 2 });
  });
});
