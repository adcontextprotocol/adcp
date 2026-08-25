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

  it('keeps descriptions-only and self-judged rows out of headline metrics', () => {
    const result = aggregate([
      row({
        shadow_eval_status: 'complete',
        shadow_eval_type: 'suppressed_opportunity',
        shadow_eval_result: { evaluation_valid: true, knowledge_gap: true },
        shadow_eval_provenance: {
          self_judged: false,
          source_answer: { model: 'claude-production' },
          tools: { mode: 'descriptions_only' },
        },
      }),
      row({
        shadow_eval_status: 'complete',
        shadow_eval_type: 'corrected_answer',
        shadow_eval_result: { evaluation_valid: true, knowledge_gap: true },
        shadow_eval_provenance: {
          self_judged: true,
          source_answer: { model: 'claude-production' },
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

  it('reports independently judged production traces by evaluation type', () => {
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
          source_answer: { model: 'claude-production' },
          tools: { mode: 'production_trace', trace_or_fixture_id: 'message-1' },
        },
        shadow_eval_shape: {
          shadow: { word_count: 200, violations: ['length_cap'], ratio_to_expected: 2 },
        },
      }),
    ]);

    expect(result.eligible_total).toBe(1);
    expect(result.eligible_by_type).toEqual({ corrected_answer: 1 });
    expect(result.knowledge_gaps_by_type).toEqual({ corrected_answer: 1 });
    expect(result.questions_with_any_violation).toBe(1);
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
});
