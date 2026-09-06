import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_ROLLOUT_POLICY_VERSION,
  evaluateFixedTraceRollout,
} from '../../../src/addie/eval/fixed-trace-rollout.js';
import type { FixedTraceBudgetSnapshot } from '../../../src/addie/eval/fixed-trace-budget.js';
import { fixedTraceJudgeSummaryUnavailable } from '../../../src/addie/eval/fixed-trace-judge.js';
import type { FixedTraceSummary } from '../../../src/addie/eval/fixed-trace-suite.js';

const summary: FixedTraceSummary = {
  diagnosticOnly: true,
  promotionBlocker: 'trusted_evaluator_context_unavailable',
  cohort: {
    architectureArm: {
      id: 'two_stage_llm_router',
      routeSource: 'llm_router',
      rolloutEligible: false,
      diagnosticOnly: true,
    },
    architectureConfigSha256: '0'.repeat(64),
    toolUniverse: {
      source: 'fixture_local_routed_replay',
      intentNarrowing: 'llm_router',
      bounded: true,
      deployable: false,
      toolNames: null,
    },
    executionEnvelope: { source: 'fixture_expectation', deployable: false },
    requestThreadFacts: { source: 'not_applicable', traceFacts: [] },
    repetition: 1,
  },
  expected: 11,
  observed: 11,
  omitted: 0,
  complete: true,
  expectedEndpointDenominators: {
    deterministic: 11,
    answer: 11,
    routing: 11,
    toolSelection: 11,
    mutationSafety: 11,
    metadata: 11,
  },
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
    unknown_exposure: 0,
    not_dispatched_budget: 0,
    not_admitted_architecture: 0,
  },
  latencyP95Ms: 20_000,
  totalEstimatedCostUsd: 0.2,
  hybridCoverage: null,
  comparisonEligible: true,
};

const judges = fixedTraceJudgeSummaryUnavailable();

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
  it('remains hard-locked when otherwise passing candidate gates have unavailable judges', () => {
    const gate = evaluateFixedTraceRollout(summary, judges, budget);
    expect(gate).toMatchObject({
      policyVersion: FIXED_TRACE_ROLLOUT_POLICY_VERSION,
      pass: false,
      failedDimensions: [
        'trusted_evaluator_context_unavailable',
        'judge_eligible',
        'judge_coverage',
        'judge_consensus',
        'judge_disagreement',
        'judge_latency',
        'judge_cost',
        'combined_cost',
      ],
    });
    expect(gate.checks).toHaveLength(18);
    expect(gate.failedDimensions).toContain('trusted_evaluator_context_unavailable');
  });

  it('fails closed for missing judge consensus and unknown budget exposure', () => {
    const gate = evaluateFixedTraceRollout(
      summary,
      judges,
      { ...budget, exposureUnknown: true, remainingUsd: null },
    );
    expect(gate.pass).toBe(false);
    expect(gate.failedDimensions).toEqual(expect.arrayContaining([
      'budget_exposure',
      'judge_eligible',
      'judge_consensus',
    ]));
  });

  it('cannot be made promotable by spoofing a diagnostic marker', () => {
    const forged = { ...summary, diagnosticOnly: false, comparisonEligible: true } as unknown as FixedTraceSummary;
    const gate = evaluateFixedTraceRollout(forged, judges, budget);
    expect(gate.pass).toBe(false);
    expect(gate.failedDimensions).toContain('trusted_evaluator_context_unavailable');
  });

  it('fails candidate eligibility for a forged incomplete summary', () => {
    const gate = evaluateFixedTraceRollout(
      { ...summary, observed: 10, omitted: 1, complete: false, comparisonEligible: true },
      judges,
      budget,
    );
    expect(gate.pass).toBe(false);
    expect(gate.failedDimensions).toContain('candidate_eligible');
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
      judges,
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
