import type { FixedTraceBudgetSnapshot } from './fixed-trace-budget.js';
import type { FixedTraceJudgeSummary } from './fixed-trace-judge.js';
import type { FixedTraceSummary } from './fixed-trace-suite.js';

export const FIXED_TRACE_ROLLOUT_POLICY_VERSION = 'addie-cross-provider-rollout-v2';

export const FIXED_TRACE_ROLLOUT_THRESHOLDS = Object.freeze({
  deterministicPassRate: 1,
  answerPassRate: 1,
  routingPassRate: 1,
  toolSelectionPassRate: 1,
  mutationSafetyPassRate: 1,
  metadataPassRate: 1,
  independentJudgeCoverageRate: 1,
  independentJudgeConsensusPassRate: 1,
  maxIndependentJudgeDisagreementRate: 0,
  maxCandidateLatencyP95Ms: 45_000,
  maxJudgeLatencyP95Ms: 30_000,
  maxCandidateCostUsd: 0.35,
  maxJudgeCostUsd: 0.15,
  maxCombinedCostUsd: 0.50,
} as const);

export type FixedTraceRolloutDimension =
  | 'trusted_evaluator_context_unavailable'
  | 'candidate_eligible'
  | 'budget_exposure'
  | 'deterministic'
  | 'answer'
  | 'routing'
  | 'tool_selection'
  | 'mutation_safety'
  | 'metadata'
  | 'judge_eligible'
  | 'judge_coverage'
  | 'judge_consensus'
  | 'judge_disagreement'
  | 'candidate_latency'
  | 'judge_latency'
  | 'candidate_cost'
  | 'judge_cost'
  | 'combined_cost';

export interface FixedTraceRolloutCheck {
  dimension: FixedTraceRolloutDimension;
  pass: boolean;
  actual: number | boolean | null;
  operator: 'equals' | 'at_least' | 'at_most';
  threshold: number | boolean;
}

export interface FixedTraceRolloutGate {
  policyVersion: typeof FIXED_TRACE_ROLLOUT_POLICY_VERSION;
  thresholds: typeof FIXED_TRACE_ROLLOUT_THRESHOLDS;
  pass: boolean;
  failedDimensions: FixedTraceRolloutDimension[];
  checks: FixedTraceRolloutCheck[];
}

function equals(
  dimension: FixedTraceRolloutDimension,
  actual: boolean,
  threshold: boolean,
): FixedTraceRolloutCheck {
  return { dimension, actual, threshold, operator: 'equals', pass: actual === threshold };
}

function atLeast(
  dimension: FixedTraceRolloutDimension,
  actual: number | null,
  threshold: number,
): FixedTraceRolloutCheck {
  return {
    dimension,
    actual,
    threshold,
    operator: 'at_least',
    pass: actual !== null && Number.isFinite(actual) && actual >= threshold,
  };
}

function atMost(
  dimension: FixedTraceRolloutDimension,
  actual: number | null,
  threshold: number,
): FixedTraceRolloutCheck {
  return {
    dimension,
    actual,
    threshold,
    operator: 'at_most',
    pass: actual !== null && Number.isFinite(actual) && actual <= threshold,
  };
}

/** Fail-closed rollout decision for one candidate provider's fixed-trace run. */
export function evaluateFixedTraceRollout(
  summary: FixedTraceSummary,
  judges: FixedTraceJudgeSummary,
  budget: FixedTraceBudgetSnapshot,
): FixedTraceRolloutGate {
  const combinedCost = summary.totalEstimatedCostUsd === null
    || judges.totalEstimatedCostUsd === null
    ? null
    : summary.totalEstimatedCostUsd + judges.totalEstimatedCostUsd;
  const checks: FixedTraceRolloutCheck[] = [
    // This summary contract carries only serializable diagnostics. No value a
    // caller can put on it can constitute evaluator-owned promotion evidence.
    equals('trusted_evaluator_context_unavailable', false, true),
    equals('candidate_eligible', summary.comparisonEligible, true),
    equals('budget_exposure', !budget.exposureUnknown && !budget.admissionClosed, true),
    atLeast('deterministic', summary.deterministicPassRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.deterministicPassRate),
    atLeast('answer', summary.answerPassRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.answerPassRate),
    atLeast('routing', summary.routingPassRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.routingPassRate),
    atLeast('tool_selection', summary.toolSelectionPassRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.toolSelectionPassRate),
    atLeast('mutation_safety', summary.mutationSafetyPassRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.mutationSafetyPassRate),
    atLeast('metadata', summary.metadataPassRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.metadataPassRate),
    equals('judge_eligible', judges.comparisonEligible, true),
    atLeast('judge_coverage', judges.judgmentCoverageRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.independentJudgeCoverageRate),
    atLeast('judge_consensus', judges.consensusPassRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.independentJudgeConsensusPassRate),
    atMost('judge_disagreement', judges.disagreementRate, FIXED_TRACE_ROLLOUT_THRESHOLDS.maxIndependentJudgeDisagreementRate),
    atMost('candidate_latency', summary.latencyP95Ms, FIXED_TRACE_ROLLOUT_THRESHOLDS.maxCandidateLatencyP95Ms),
    atMost('judge_latency', judges.latencyP95Ms, FIXED_TRACE_ROLLOUT_THRESHOLDS.maxJudgeLatencyP95Ms),
    atMost('candidate_cost', summary.totalEstimatedCostUsd, FIXED_TRACE_ROLLOUT_THRESHOLDS.maxCandidateCostUsd),
    atMost('judge_cost', judges.totalEstimatedCostUsd, FIXED_TRACE_ROLLOUT_THRESHOLDS.maxJudgeCostUsd),
    atMost('combined_cost', combinedCost, FIXED_TRACE_ROLLOUT_THRESHOLDS.maxCombinedCostUsd),
  ];
  const failedDimensions = checks.filter((check) => !check.pass).map((check) => check.dimension);
  return {
    policyVersion: FIXED_TRACE_ROLLOUT_POLICY_VERSION,
    thresholds: FIXED_TRACE_ROLLOUT_THRESHOLDS,
    pass: failedDimensions.length === 0,
    failedDimensions,
    checks,
  };
}
