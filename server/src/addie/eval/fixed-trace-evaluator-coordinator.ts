/**
 * B is deliberately a refusal boundary, not an evidence coordinator. A's
 * unified final protocol currently has unavailable schedule, dated pricing,
 * custody, calibration, and final admission artifacts. Positive contract and
 * ledger schemas belong to the later sealed evaluator boundary (C), where
 * they can include repetition, episode, block/order/position, seed, worker,
 * adjudication, custody, and missingness bindings.
 */
import {
  FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION,
  FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
  assertFixedTraceEvidencePrerequisitePinned,
  type FixedTraceSealedEvidenceRequirementManifest,
} from "./fixed-trace-evidence-prerequisite.js";

export const FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION =
  FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION;

export interface FixedTraceCoordinatorUnavailable {
  readonly status: "unavailable";
  readonly admission: typeof FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION;
  /** C must supply this whole sealed contract; B exports no positive ledger. */
  readonly requiredSealedEvidence: FixedTraceSealedEvidenceRequirementManifest;
}

const UNAVAILABLE_COORDINATOR: FixedTraceCoordinatorUnavailable = Object.freeze({
  status: "unavailable",
  admission: FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
  requiredSealedEvidence: FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
});

/**
 * Deliberately accepts no capability and examines no caller data. It has no
 * signer, validator, issuance method, replay store, or ledger shape.
 */
export function fixedTraceEvaluatorCoordinatorUnavailable(): FixedTraceCoordinatorUnavailable {
  assertFixedTraceEvidencePrerequisitePinned();
  return UNAVAILABLE_COORDINATOR;
}
