import type {
  ShadowReplayGenerationSummaryRow,
  ShadowReplayJudgmentSummaryRow,
} from './shadow-replay-trace.js';

export const SHADOW_REPLAY_PROMOTION_POLICY_VERSION =
  'official-docs-shadow-promotion:v1' as const;

// Per-observation limits mirror the already-reviewed fixed-trace rollout envelope:
// $0.35 / 11 candidate cases and $0.15 / 7 subjectively judged cases.
export const SHADOW_REPLAY_PROMOTION_THRESHOLDS = Object.freeze({
  minimumSamples: 30,
  minimumGenerationSuccessRate: 1,
  minimumGenerationUsageCoverageRate: 1,
  minimumGenerationLatencyCoverageRate: 1,
  minimumJudgmentCoverageRate: 1,
  minimumJudgmentSuccessRate: 1,
  minimumJudgmentUsageCoverageRate: 1,
  minimumJudgmentLatencyCoverageRate: 1,
  minimumAcceptableAnswerRate: 1,
  maximumSignificantGapRate: 0,
  maximumCandidateLatencyP95Ms: 45_000,
  maximumJudgeLatencyP95Ms: 30_000,
  maximumCandidateAverageCostMicros: 31_819,
  maximumJudgeAverageCostMicros: 21_429,
} as const);

export type ShadowReplayPromotionDimension =
  | 'single_candidate_cohort'
  | 'single_judge_cohort'
  | 'cohort_alignment'
  | 'minimum_samples'
  | 'generation_success'
  | 'generation_usage'
  | 'generation_latency'
  | 'judgment_coverage'
  | 'judgment_success'
  | 'judgment_independence'
  | 'judgment_usage'
  | 'judgment_latency'
  | 'answer_quality'
  | 'significant_knowledge_gap'
  | 'candidate_latency'
  | 'judge_latency'
  | 'candidate_cost'
  | 'judge_cost';

export interface ShadowReplayPromotionCheck {
  dimension: ShadowReplayPromotionDimension;
  actual: boolean | number | null;
  threshold: boolean | number;
  operator: 'equals' | 'at_least' | 'at_most';
  pass: boolean;
}

export interface ShadowReplayPromotionDecision {
  policy_version: typeof SHADOW_REPLAY_PROMOTION_POLICY_VERSION;
  scope: 'shadow_evidence_only';
  limitation: 'fixed_trace_gate_must_pass_separately';
  thresholds: typeof SHADOW_REPLAY_PROMOTION_THRESHOLDS;
  pass: boolean;
  failed_dimensions: ShadowReplayPromotionDimension[];
  evidence: {
    candidate_cohorts: number;
    judge_cohorts: number;
    generation_total: number;
    generation_succeeded: number;
    judgment_total: number;
    judgment_judged: number;
  };
  checks: ShadowReplayPromotionCheck[];
}

function rate(numerator: number, denominator: number): number | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || denominator <= 0 || numerator < 0 || numerator > denominator) {
    return null;
  }
  return numerator / denominator;
}

function equals(
  dimension: ShadowReplayPromotionDimension,
  actual: boolean,
  threshold: boolean,
): ShadowReplayPromotionCheck {
  return { dimension, actual, threshold, operator: 'equals', pass: actual === threshold };
}

function atLeast(
  dimension: ShadowReplayPromotionDimension,
  actual: number | null,
  threshold: number,
): ShadowReplayPromotionCheck {
  return {
    dimension,
    actual,
    threshold,
    operator: 'at_least',
    pass: actual !== null && Number.isFinite(actual) && actual >= threshold,
  };
}

function atMost(
  dimension: ShadowReplayPromotionDimension,
  actual: number | null,
  threshold: number,
): ShadowReplayPromotionCheck {
  return {
    dimension,
    actual,
    threshold,
    operator: 'at_most',
    pass: actual !== null && Number.isFinite(actual) && actual <= threshold,
  };
}

function generationCohort(row: ShadowReplayGenerationSummaryRow): string {
  return JSON.stringify([
    row.capture_version,
    row.capture_policy_version,
    row.source_config_version_id,
    row.source_model,
    row.requested_provider,
    row.requested_model,
    row.addie_code_version,
    row.execution_policy_version,
    row.pricing_version,
    row.returned_provider,
    row.returned_model,
  ]);
}

function candidateIdentity(
  row: ShadowReplayGenerationSummaryRow | ShadowReplayJudgmentSummaryRow,
): string {
  return JSON.stringify([
    row.capture_version,
    row.capture_policy_version,
    row.source_config_version_id,
    row.source_model,
    row.requested_provider,
    row.requested_model,
    row.addie_code_version,
    row.execution_policy_version,
    row.returned_provider,
    row.returned_model,
  ]);
}

function judgeCohort(row: ShadowReplayJudgmentSummaryRow): string {
  return JSON.stringify([
    candidateIdentity(row),
    row.has_human_evidence,
    row.judgment_policy_version,
    row.judge_provider,
    row.judge_model,
    row.self_judged,
    row.judge_prompt_version,
    row.pricing_version,
  ]);
}

function count(rows: Array<{ count: number }>): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

function sumCost(rows: Array<{ estimated_cost_micros: string }>): number | null {
  try {
    const total = rows.reduce(
      (sum, row) => sum + BigInt(row.estimated_cost_micros),
      0n,
    );
    if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(total);
  } catch {
    return null;
  }
}

function maximumLatency(rows: Array<{ latency_p95_ms: number | null }>): number | null {
  const values = rows.map((row) => row.latency_p95_ms);
  if (values.length === 0 || values.some((value) => value === null || !Number.isFinite(value))) {
    return null;
  }
  return Math.max(...values as number[]);
}

/**
 * Produce an advisory, aggregate-only promotion decision for exactly one
 * production shadow cohort. It never changes provider selection or canary
 * configuration, and the fixed-trace safety gate must pass separately.
 */
export function evaluateShadowReplayPromotion(
  generations: ShadowReplayGenerationSummaryRow[],
  judgments: ShadowReplayJudgmentSummaryRow[],
): ShadowReplayPromotionDecision {
  const thresholds = SHADOW_REPLAY_PROMOTION_THRESHOLDS;
  const candidateCohorts = new Set(generations.map(generationCohort));
  const judgeCohorts = new Set(judgments.map(judgeCohort));
  const candidateIdentities = new Set(generations.map(candidateIdentity));
  const judgmentCandidateIdentities = new Set(judgments.map(candidateIdentity));
  const cohortsAligned = candidateIdentities.size === 1
    && judgmentCandidateIdentities.size === 1
    && [...judgmentCandidateIdentities].every((identity) => candidateIdentities.has(identity));

  const generationTotal = count(generations);
  const succeededGenerations = generations.filter((row) => row.status === 'succeeded');
  const generationSucceeded = count(succeededGenerations);
  const generationUsageComplete = succeededGenerations.reduce(
    (sum, row) => sum + row.usage_complete_count,
    0,
  );
  const generationLatencyComplete = succeededGenerations.reduce(
    (sum, row) => sum + row.latency_count,
    0,
  );

  const judgmentTotal = count(judgments);
  const judgedRows = judgments.filter(
    (row) => row.status === 'judged' && row.evaluation_valid && !row.evaluation_skipped,
  );
  const judgmentJudged = count(judgedRows);
  const independentJudgments = count(judgedRows.filter((row) => (
    row.has_human_evidence
    && row.self_judged === false
    && row.judge_provider !== null
    && row.judge_provider !== 'unknown'
    && row.judge_model !== null
    && row.judge_model !== row.source_model
    && row.judge_model !== row.requested_model
  )));
  const acceptableAnswers = count(judgedRows.filter(
    (row) => row.shadow_quality === 'better' || row.shadow_quality === 'equivalent',
  ));
  const significantGaps = count(judgedRows.filter(
    (row) => row.knowledge_gap === true
      && (row.gap_severity === 'significant' || row.gap_severity === 'critical'),
  ));
  const judgmentUsageComplete = judgedRows.reduce(
    (sum, row) => sum + row.usage_complete_count,
    0,
  );
  const judgmentLatencyComplete = judgedRows.reduce(
    (sum, row) => sum + row.latency_count,
    0,
  );

  const candidateCost = sumCost(succeededGenerations);
  const judgeCost = sumCost(judgedRows);
  const candidateAverageCost = candidateCost === null || generationSucceeded === 0
    ? null
    : candidateCost / generationSucceeded;
  const judgeAverageCost = judgeCost === null || judgmentJudged === 0
    ? null
    : judgeCost / judgmentJudged;
  const checks: ShadowReplayPromotionCheck[] = [
    equals('single_candidate_cohort', candidateCohorts.size === 1, true),
    equals('single_judge_cohort', judgeCohorts.size === 1, true),
    equals('cohort_alignment', cohortsAligned, true),
    atLeast('minimum_samples', generationTotal, thresholds.minimumSamples),
    atLeast(
      'generation_success',
      rate(generationSucceeded, generationTotal),
      thresholds.minimumGenerationSuccessRate,
    ),
    atLeast(
      'generation_usage',
      rate(generationUsageComplete, generationSucceeded),
      thresholds.minimumGenerationUsageCoverageRate,
    ),
    atLeast(
      'generation_latency',
      rate(generationLatencyComplete, generationSucceeded),
      thresholds.minimumGenerationLatencyCoverageRate,
    ),
    atLeast(
      'judgment_coverage',
      rate(judgmentTotal, generationSucceeded),
      thresholds.minimumJudgmentCoverageRate,
    ),
    atLeast(
      'judgment_success',
      rate(judgmentJudged, judgmentTotal),
      thresholds.minimumJudgmentSuccessRate,
    ),
    atLeast('judgment_independence', rate(independentJudgments, judgmentJudged), 1),
    atLeast(
      'judgment_usage',
      rate(judgmentUsageComplete, judgmentJudged),
      thresholds.minimumJudgmentUsageCoverageRate,
    ),
    atLeast(
      'judgment_latency',
      rate(judgmentLatencyComplete, judgmentJudged),
      thresholds.minimumJudgmentLatencyCoverageRate,
    ),
    atLeast(
      'answer_quality',
      rate(acceptableAnswers, judgmentJudged),
      thresholds.minimumAcceptableAnswerRate,
    ),
    atMost(
      'significant_knowledge_gap',
      rate(significantGaps, judgmentJudged),
      thresholds.maximumSignificantGapRate,
    ),
    atMost(
      'candidate_latency',
      maximumLatency(succeededGenerations),
      thresholds.maximumCandidateLatencyP95Ms,
    ),
    atMost(
      'judge_latency',
      maximumLatency(judgedRows),
      thresholds.maximumJudgeLatencyP95Ms,
    ),
    atMost(
      'candidate_cost',
      candidateAverageCost,
      thresholds.maximumCandidateAverageCostMicros,
    ),
    atMost(
      'judge_cost',
      judgeAverageCost,
      thresholds.maximumJudgeAverageCostMicros,
    ),
  ];
  const failedDimensions = checks.filter((check) => !check.pass).map((check) => check.dimension);

  return {
    policy_version: SHADOW_REPLAY_PROMOTION_POLICY_VERSION,
    scope: 'shadow_evidence_only',
    limitation: 'fixed_trace_gate_must_pass_separately',
    thresholds,
    pass: failedDimensions.length === 0,
    failed_dimensions: failedDimensions,
    evidence: {
      candidate_cohorts: candidateCohorts.size,
      judge_cohorts: judgeCohorts.size,
      generation_total: generationTotal,
      generation_succeeded: generationSucceeded,
      judgment_total: judgmentTotal,
      judgment_judged: judgmentJudged,
    },
    checks,
  };
}
