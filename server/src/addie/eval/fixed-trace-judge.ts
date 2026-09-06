/**
 * Slice B deliberately contains no judge request construction, provider
 * adapter, pricing calculation, clock, verdict parser, or comparison logic.
 * Those positive capabilities belong to C's sealed evaluator boundary, where
 * they can require a one-use authority and a complete authenticated evidence
 * contract. This module is safe to import while A prerequisites are absent.
 */
import {
  FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION,
  FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
  assertFixedTraceEvidencePrerequisitePinned,
  type FixedTraceSealedEvidenceRequirementManifest,
} from "./fixed-trace-evidence-prerequisite.js";

export const FIXED_TRACE_JUDGE_PROMPT_VERSION = "addie-fixed-trace-blinded-judge-v2";
export const FIXED_TRACE_MIN_INDEPENDENT_JUDGES = 2 as const;
export const FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION =
  FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION;

export interface FixedTraceJudgeUnavailable {
  readonly status: "unavailable";
  readonly admission: typeof FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION;
  /** Positive judging in C must bind every one of these fields. */
  readonly requiredSealedEvidence: FixedTraceSealedEvidenceRequirementManifest;
}

/**
 * Compatibility type for the existing rollout consumer. It encodes an
 * unavailable judge system, never observed or eligible judgment evidence.
 * C owns the future sealed positive result contract.
 */
export interface FixedTraceJudgeSummary extends FixedTraceJudgeUnavailable {
  readonly expectedCases: 0;
  readonly expectedJudgments: 0;
  readonly observedJudgments: 0;
  readonly judgedJudgments: 0;
  readonly expectedRecordCountObserved: false;
  readonly judgmentCoverageRate: null;
  readonly consensusPassRate: null;
  readonly disagreementRate: null;
  readonly latencyP95Ms: null;
  readonly totalEstimatedCostUsd: null;
  readonly comparisonEligible: false;
}

const UNAVAILABLE_JUDGE = Object.freeze({
  status: "unavailable" as const,
  admission: FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION,
  requiredSealedEvidence: FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
});

/**
 * It accepts no caller value. It validates the one literal A pin, then
 * returns the non-admitting state whether the pin is intact or drifted; no
 * proxy, adapter, provider, model, pricing object, or clock is inspected.
 */
export function fixedTraceJudgeUnavailable(): FixedTraceJudgeUnavailable {
  assertFixedTraceEvidencePrerequisitePinned();
  return UNAVAILABLE_JUDGE;
}

export function fixedTraceJudgeSummaryUnavailable(): FixedTraceJudgeSummary {
  const unavailable = fixedTraceJudgeUnavailable();
  return Object.freeze({
    ...unavailable,
    expectedCases: 0,
    expectedJudgments: 0,
    observedJudgments: 0,
    judgedJudgments: 0,
    expectedRecordCountObserved: false,
    judgmentCoverageRate: null,
    consensusPassRate: null,
    disagreementRate: null,
    latencyP95Ms: null,
    totalEstimatedCostUsd: null,
    comparisonEligible: false,
  });
}
