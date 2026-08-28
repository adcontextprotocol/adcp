import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_ROLLOUT_POLICY_VERSION,
  evaluateFixedTraceRollout,
} from '../../../src/addie/eval/fixed-trace-rollout.js';
import type { FixedTraceBudgetSnapshot } from '../../../src/addie/eval/fixed-trace-budget.js';
import type { FixedTraceJudgeSummary } from '../../../src/addie/eval/fixed-trace-judge.js';
import type { FixedTraceSummary } from '../../../src/addie/eval/fixed-trace-suite.js';

const summary: FixedTraceSummary = {
  expected: 11,
  observed: 11,
  omitted: 0,
  complete: true,
  deterministicPassRate: 1,
  answerPassRate: 1,
  routingPassRate: 1,
  toolSelectionPassRate: 1,
  mutationSafetyPassRate: 1,
  metadataPassRate: 1,
  terminalFailureRate: 2 / 11,
  terminalStatusCounts: {
    complete: 8,
    ignored: 1,
    reacted: 0,
    refusal: 0,
    truncated: 1,
    empty: 0,
    malformed: 0,
    provider_error: 1,
    timeout_after_dispatch: 0,
    not_dispatched_budget: 0,
  },
  latencyP95Ms: 20_000,
  totalEstimatedCostUsd: 0.2,
  comparisonEligible: true,
};

const judges: FixedTraceJudgeSummary = {
  expectedCases: 7,
  expectedJudgments: 14,
  observedJudgments: 14,
  judgedJudgments: 14,
  complete: true,
  judgmentCoverageRate: 1,
  consensusPassRate: 1,
  disagreementRate: 0,
  latencyP95Ms: 10_000,
  totalEstimatedCostUsd: 0.1,
  comparisonEligible: true,
};

const budget: FixedTraceBudgetSnapshot = {
  policy: 'soft_admission_target',
  softMaxUsd: 1,
  accountedSpendUsd: 0.3,
  reservedUsd: 0,
  remainingUsd: 0.7,
  dispatchedCalls: 30,
  completedCalls: 30,
  budgetRejectedCalls: 0,
  admissionClosed: false,
  exposureUnknown: false,
};

describe('fixed-trace rollout policy', () => {
  it('passes only when every answer, tool, safety, latency, cost, and judge gate passes', () => {
    const gate = evaluateFixedTraceRollout(summary, judges, budget);
    expect(gate).toMatchObject({
      policyVersion: FIXED_TRACE_ROLLOUT_POLICY_VERSION,
      pass: true,
      failedDimensions: [],
    });
    expect(gate.checks).toHaveLength(17);
    expect(gate.checks.every((check) => check.pass)).toBe(true);
  });

  it('fails closed for missing judge consensus and unknown budget exposure', () => {
    const gate = evaluateFixedTraceRollout(
      summary,
      { ...judges, consensusPassRate: null, comparisonEligible: false },
      { ...budget, exposureUnknown: true, remainingUsd: null },
    );
    expect(gate.pass).toBe(false);
    expect(gate.failedDimensions).toEqual(expect.arrayContaining([
      'budget_exposure',
      'judge_eligible',
      'judge_consensus',
    ]));
  });

  it('reports each violated quality, mutation, latency, and cost dimension', () => {
    const gate = evaluateFixedTraceRollout(
      {
        ...summary,
        answerPassRate: 0.9,
        toolSelectionPassRate: 0.9,
        mutationSafetyPassRate: 0,
        latencyP95Ms: 60_000,
        totalEstimatedCostUsd: 0.4,
      },
      {
        ...judges,
        consensusPassRate: 0.8,
        disagreementRate: 0.2,
        latencyP95Ms: 40_000,
        totalEstimatedCostUsd: 0.2,
      },
      budget,
    );
    expect(gate.pass).toBe(false);
    expect(gate.failedDimensions).toEqual(expect.arrayContaining([
      'answer',
      'tool_selection',
      'mutation_safety',
      'judge_consensus',
      'judge_disagreement',
      'candidate_latency',
      'judge_latency',
      'candidate_cost',
      'judge_cost',
      'combined_cost',
    ]));
  });
});
