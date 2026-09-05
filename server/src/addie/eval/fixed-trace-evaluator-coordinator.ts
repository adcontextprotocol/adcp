/**
 * B is deliberately a refusal boundary, not an evidence coordinator. A's
 * unified final protocol currently has unavailable schedule, dated pricing,
 * custody, calibration, and final admission artifacts. Positive contract and
 * ledger schemas belong to the later sealed evaluator boundary (C), where
 * they can include repetition, episode, block/order/position, seed, worker,
 * adjudication, custody, and missingness bindings.
 */
import {
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  fixedTraceEvaluationProtocolFingerprint,
} from "./fixed-trace-evaluation-protocol.js";

export const FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION =
  "not_admitted_missing_validated_A_schedule_pricing_custody_and_calibration" as const;

export interface FixedTraceCoordinatorUnavailable {
  readonly status: "unavailable";
  readonly admission: typeof FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION;
}

export class FixedTraceEvaluatorCoordinatorUnavailableError extends Error {
  constructor() {
    super(FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION);
    this.name = "FixedTraceEvaluatorCoordinatorUnavailableError";
  }
}

const FIXED_TRACE_COORDINATOR_PREREQUISITE = Object.freeze({
  protocolFingerprint: fixedTraceEvaluationProtocolFingerprint(
    FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  ),
  scheduleDigest: FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol.finalRandomization.scheduleDigest,
  pricingCohortDigest: FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol.prospectivePricingCohort.digest,
  calibrationStatus: FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol.judgeCalibration.status,
  custodyStatus: FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol.externalPackCustody.status,
} as const);

/**
 * Deliberately accepts no capability and examines no caller data. It has no
 * signer, validator, issuance method, replay store, or ledger shape.
 */
export function fixedTraceEvaluatorCoordinatorUnavailable(): never {
  const finalProtocol = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol;
  if (
    fixedTraceEvaluationProtocolFingerprint(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL)
      !== FIXED_TRACE_COORDINATOR_PREREQUISITE.protocolFingerprint
    || finalProtocol.finalRandomization.scheduleDigest
      !== FIXED_TRACE_COORDINATOR_PREREQUISITE.scheduleDigest
    || finalProtocol.prospectivePricingCohort.digest
      !== FIXED_TRACE_COORDINATOR_PREREQUISITE.pricingCohortDigest
    || finalProtocol.judgeCalibration.status
      !== FIXED_TRACE_COORDINATOR_PREREQUISITE.calibrationStatus
    || finalProtocol.externalPackCustody.status
      !== FIXED_TRACE_COORDINATOR_PREREQUISITE.custodyStatus
  ) throw new FixedTraceEvaluatorCoordinatorUnavailableError();
  throw new FixedTraceEvaluatorCoordinatorUnavailableError();
}
