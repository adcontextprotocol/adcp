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
  assertFixedTraceEvidencePrerequisiteUnavailable,
  type FixedTraceSealedEvidenceRequirements,
} from "./fixed-trace-evidence-prerequisite.js";

export const FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION =
  FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION;

export interface FixedTraceCoordinatorUnavailable {
  readonly status: "unavailable";
  readonly admission: typeof FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION;
  /** C must supply this whole sealed contract; B exports no positive ledger. */
  readonly requiredSealedEvidence: readonly (keyof FixedTraceSealedEvidenceRequirements)[];
}

const REQUIRED_SEALED_EVIDENCE = Object.freeze([
  "protocolFingerprint", "corpusSuiteVersion", "corpusSuiteSha256",
  "partitionManifestSha256", "experimentalDesignFingerprint",
  "measurementManifestSha256", "phase", "arm", "caseId", "repetition",
  "episodeId", "blockId", "order", "position", "randomizationSeed",
  "scheduleDigest", "workerIdentity", "adjudicationBinding", "custodyBinding",
  "missingnessBinding", "pricingCohortDigest", "pricingEffectiveFrom",
  "pricingEffectiveBefore", "calibrationDigest", "providerExposureLedgerDigest",
] as const satisfies readonly (keyof FixedTraceSealedEvidenceRequirements)[]);

const UNAVAILABLE_COORDINATOR: FixedTraceCoordinatorUnavailable = Object.freeze({
  status: "unavailable",
  admission: FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
  requiredSealedEvidence: REQUIRED_SEALED_EVIDENCE,
});

/**
 * Deliberately accepts no capability and examines no caller data. It has no
 * signer, validator, issuance method, replay store, or ledger shape.
 */
export function fixedTraceEvaluatorCoordinatorUnavailable(): FixedTraceCoordinatorUnavailable {
  try {
    assertFixedTraceEvidencePrerequisiteUnavailable();
  } catch {
    return UNAVAILABLE_COORDINATOR;
  }
  return UNAVAILABLE_COORDINATOR;
}
