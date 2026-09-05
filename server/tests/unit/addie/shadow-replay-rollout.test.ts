import { describe, expect, it } from 'vitest';
import {
  evaluateShadowReplayPromotion,
  SHADOW_REPLAY_PROMOTION_POLICY_VERSION,
} from '../../../src/addie/jobs/shadow-replay-rollout.js';
import type {
  ShadowReplayGenerationSummaryRow,
  ShadowReplayJudgmentSummaryRow,
} from '../../../src/addie/jobs/shadow-replay-trace.js';

function generation(
  overrides: Partial<ShadowReplayGenerationSummaryRow> = {},
): ShadowReplayGenerationSummaryRow {
  return {
    capture_version: 3,
    capture_policy_version: 'official-docs-shadow:v1',
    source_config_version_id: 42,
    source_model: 'claude-sonnet-5',
    requested_provider: 'google',
    requested_model: 'gemini-3.7-flash',
    addie_code_version: '2026.08.115',
    execution_policy_version: 'official-docs-shadow:v1',
    pricing_version: 'google-gemini-3.7-flash-2026-08',
    returned_provider: 'google',
    returned_model: 'gemini-3.7-flash',
    status: 'succeeded',
    reason: 'generation_succeeded',
    count: 30,
    input_tokens: 3_000,
    output_tokens: 1_500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usage_complete_count: 30,
    latency_count: 30,
    estimated_cost_micros: '300000',
    latency_p50_ms: 2_000,
    latency_p95_ms: 4_000,
    ...overrides,
  };
}

function judgment(
  overrides: Partial<ShadowReplayJudgmentSummaryRow> = {},
): ShadowReplayJudgmentSummaryRow {
  return {
    capture_version: 3,
    capture_policy_version: 'official-docs-shadow:v1',
    source_config_version_id: 42,
    source_model: 'claude-sonnet-5',
    has_human_evidence: true,
    requested_provider: 'google',
    requested_model: 'gemini-3.7-flash',
    addie_code_version: '2026.08.115',
    execution_policy_version: 'official-docs-shadow:v1',
    returned_provider: 'google',
    returned_model: 'gemini-3.7-flash',
    judgment_policy_version: 'official-docs-judgment:v1',
    judge_provider: 'anthropic',
    judge_model: 'claude-opus-4-6',
    self_judged: false,
    judge_prompt_version: 'official-docs-independent-judge:v1',
    pricing_version: 'anthropic-standard-2026-09:claude-opus-4-6',
    status: 'judged',
    reason: 'judgment_succeeded',
    evaluation_valid: true,
    evaluation_skipped: false,
    knowledge_gap: false,
    gap_severity: 'none',
    shadow_quality: 'equivalent',
    deterministic_failure_labels: [],
    count: 30,
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usage_complete_count: 30,
    latency_count: 30,
    estimated_cost_micros: '300000',
    latency_p50_ms: 1_500,
    latency_p95_ms: 3_000,
    ...overrides,
  };
}

describe('shadow replay promotion gate', () => {
  it('admits one complete exact cohort without enabling a canary', () => {
    expect(evaluateShadowReplayPromotion([generation()], [judgment()])).toMatchObject({
      policy_version: SHADOW_REPLAY_PROMOTION_POLICY_VERSION,
      scope: 'shadow_evidence_only',
      limitation: 'fixed_trace_gate_must_pass_separately',
      pass: true,
      failed_dimensions: [],
      evidence: {
        candidate_cohorts: 1,
        judge_cohorts: 1,
        generation_total: 30,
        judgment_total: 30,
      },
    });
  });

  it('fails closed when there is no evidence', () => {
    const result = evaluateShadowReplayPromotion([], []);
    expect(result.pass).toBe(false);
    expect(result.failed_dimensions).toEqual(expect.arrayContaining([
      'single_candidate_cohort',
      'single_judge_cohort',
      'cohort_alignment',
      'minimum_samples',
      'generation_success',
      'judgment_coverage',
      'candidate_latency',
      'candidate_cost',
    ]));
  });

  it('rejects mixed candidate, code, pricing, or judge cohorts', () => {
    const result = evaluateShadowReplayPromotion(
      [
        generation({ count: 15 }),
        generation({ count: 15, addie_code_version: '2026.08.114' }),
      ],
      [
        judgment({ count: 15 }),
        judgment({ count: 15, judge_model: 'claude-haiku-4-5' }),
      ],
    );
    expect(result.pass).toBe(false);
    expect(result.failed_dimensions).toEqual(expect.arrayContaining([
      'single_candidate_cohort',
      'single_judge_cohort',
      'cohort_alignment',
    ]));
  });

  it('keeps failures, skipped judgments, and incomplete telemetry in the denominator', () => {
    const result = evaluateShadowReplayPromotion(
      [
        generation({ count: 29, usage_complete_count: 28, latency_count: 28 }),
        generation({
          count: 1,
          status: 'error',
          reason: 'provider_error',
          returned_provider: null,
          returned_model: null,
          usage_complete_count: 0,
          latency_count: 0,
          estimated_cost_micros: '0',
          latency_p50_ms: null,
          latency_p95_ms: null,
        }),
      ],
      [
        judgment({ count: 28, usage_complete_count: 27, latency_count: 27 }),
        judgment({
          count: 1,
          status: 'skipped',
          reason: 'judge_usage_unavailable',
          evaluation_valid: false,
          evaluation_skipped: true,
          shadow_quality: null,
          knowledge_gap: null,
          gap_severity: null,
          usage_complete_count: 0,
          latency_count: 0,
          estimated_cost_micros: '0',
          latency_p50_ms: null,
          latency_p95_ms: null,
        }),
      ],
    );
    expect(result.failed_dimensions).toEqual(expect.arrayContaining([
      'generation_success',
      'generation_usage',
      'generation_latency',
      'judgment_success',
      'judgment_usage',
      'judgment_latency',
    ]));
  });

  it('blocks self-judging, weak answers, significant gaps, and breached bounds', () => {
    const result = evaluateShadowReplayPromotion(
      [generation({ estimated_cost_micros: '954600', latency_p95_ms: 45_001 })],
      [judgment({
        judge_model: 'gemini-3.7-flash',
        judge_provider: 'google',
        self_judged: true,
        shadow_quality: 'worse',
        knowledge_gap: true,
        gap_severity: 'significant',
        estimated_cost_micros: '642900',
        latency_p95_ms: 30_001,
      })],
    );
    expect(result.failed_dimensions).toEqual(expect.arrayContaining([
      'judgment_independence',
      'answer_quality',
      'significant_knowledge_gap',
      'candidate_latency',
      'judge_latency',
      'candidate_cost',
      'judge_cost',
    ]));
  });

  it('treats malformed aggregate cost evidence as unavailable', () => {
    const result = evaluateShadowReplayPromotion(
      [generation({ estimated_cost_micros: 'not-a-number' })],
      [judgment({ estimated_cost_micros: '-1' })],
    );
    expect(result.failed_dimensions).toEqual(expect.arrayContaining([
      'candidate_cost',
      'judge_cost',
    ]));
  });
});
