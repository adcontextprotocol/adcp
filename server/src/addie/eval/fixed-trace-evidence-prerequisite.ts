/**
 * B's fixed, reviewable view of A.  These values are literals on purpose:
 * replacing A, the corpus, partition, or experimental design requires an
 * explicit B pin update and review.  This is a refusal prerequisite only;
 * it is not an authority to issue a contract or dispatch a provider.
 */
import { createHash } from "node:crypto";
import {
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  assertFixedTraceEvaluationProtocol,
  fixedTraceEvaluationProtocolFingerprint,
} from "./fixed-trace-evaluation-protocol.js";
import {
  FIXED_TRACE_EXPERIMENTAL_DESIGN,
  assertFixedTraceExperimentalDesign,
  fixedTraceExperimentalDesignFingerprint,
} from "./fixed-trace-experimental-design.js";
import {
  FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  assertFixedTracePartitionManifest,
} from "./fixed-trace-partition.js";
import {
  FIXED_TRACE_FICTIONAL_IDENTITY_MANIFEST,
  FIXED_TRACE_SUITE,
  FIXED_TRACE_SUITE_VERSION,
  fixedTraceSuiteSha256,
} from "./fixed-trace-suite.js";

export const FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION =
  "not_admitted_missing_validated_A_schedule_pricing_custody_calibration_and_C_sealed_authority" as const;

/** Complete C-owned fields required before any positive evidence exists. */
export interface FixedTraceSealedEvidenceRequirements {
  readonly protocolFingerprint: string;
  readonly corpusSuiteVersion: string;
  readonly corpusSuiteSha256: string;
  readonly partitionManifestSha256: string;
  readonly experimentalDesignFingerprint: string;
  readonly measurementManifestSha256: string;
  readonly phase: string;
  readonly arm: string;
  readonly caseId: string;
  readonly repetition: number;
  readonly episodeId: string;
  readonly blockId: string;
  readonly order: number;
  readonly position: number;
  readonly randomizationSeed: string;
  readonly scheduleDigest: string;
  readonly workerIdentity: string;
  readonly adjudicationBinding: string;
  readonly custodyBinding: string;
  readonly missingnessBinding: string;
  readonly pricingCohortDigest: string;
  readonly pricingEffectiveFrom: string;
  readonly pricingEffectiveBefore: string | null;
  readonly calibrationDigest: string;
  readonly providerExposureLedgerDigest: string;
}

export interface FixedTraceEvidencePrerequisitePin {
  readonly protocolFingerprint: string;
  readonly corpusSuiteVersion: string;
  readonly corpusSuiteSha256: string;
  readonly partitionManifestSha256: string;
  readonly experimentalDesignFingerprint: string;
  readonly measurementManifestSha256: string;
  readonly schedule: { readonly status: "unavailable"; readonly digest: null };
  readonly pricingWindow: {
    readonly status: "unavailable";
    readonly cohortId: null;
    readonly effectiveFrom: null;
    readonly effectiveBefore: null;
    readonly digest: null;
  };
  readonly calibration: { readonly status: "unavailable"; readonly digest: null };
  readonly providerExposure: { readonly status: "unavailable"; readonly digest: null };
  readonly custody: { readonly status: "unavailable"; readonly digest: null };
}

export const FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN: FixedTraceEvidencePrerequisitePin =
  Object.freeze({
    protocolFingerprint: "b9ef28a8451ca606bbc77e48ff709405e90290c55833bb76e8047a7633e6c7dd",
    corpusSuiteVersion: "addie-fixed-traces-v32",
    corpusSuiteSha256: "5f7f0a6d653a4757991728a1d9de8aee69b40d580dafb65e98941c1f9e3fea83",
    partitionManifestSha256: "99a0727723fd84bcc4c7f40852a0e2392b578964bb4e7b0954739946451e4b96",
    experimentalDesignFingerprint: "d4f54eae99a90426ba43c5a4a26a7196102bc524537cdec56d32f0df8d9fb153",
    measurementManifestSha256: "ba46e9ddd18171602b4d17ff0e5bf6e1ad6bfee997236bdb1b345c3c817a41e0",
    schedule: Object.freeze({ status: "unavailable", digest: null }),
    pricingWindow: Object.freeze({
      status: "unavailable", cohortId: null, effectiveFrom: null,
      effectiveBefore: null, digest: null,
    }),
    calibration: Object.freeze({ status: "unavailable", digest: null }),
    providerExposure: Object.freeze({ status: "unavailable", digest: null }),
    custody: Object.freeze({ status: "unavailable", digest: null }),
  });

function measurementManifestSha256(): string {
  return createHash("sha256")
    .update(JSON.stringify(FIXED_TRACE_FICTIONAL_IDENTITY_MANIFEST), "utf8")
    .digest("hex");
}

/**
 * Verify A and every prerequisite field against the literal pin.  The final
 * unconditional throw is intentional: B cannot turn this check into a
 * caller-controlled positive admission.
 */
export function assertFixedTraceEvidencePrerequisiteUnavailable(): never {
  assertFixedTraceEvaluationProtocol(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
  assertFixedTracePartitionManifest();
  assertFixedTraceExperimentalDesign();
  const final = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol;
  const pin = FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN;
  const drifted =
    fixedTraceEvaluationProtocolFingerprint(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) !== pin.protocolFingerprint
    || FIXED_TRACE_SUITE_VERSION !== pin.corpusSuiteVersion
    || fixedTraceSuiteSha256(FIXED_TRACE_SUITE) !== pin.corpusSuiteSha256
    || FIXED_TRACE_PARTITION_MANIFEST_SHA256 !== pin.partitionManifestSha256
    || fixedTraceExperimentalDesignFingerprint(FIXED_TRACE_EXPERIMENTAL_DESIGN)
      !== pin.experimentalDesignFingerprint
    || measurementManifestSha256() !== pin.measurementManifestSha256
    || final.status !== "unavailable"
    || final.finalRandomization.scheduleDigest !== pin.schedule.digest
    || final.prospectivePricingCohort.id !== pin.pricingWindow.cohortId
    || final.prospectivePricingCohort.effectiveFrom !== pin.pricingWindow.effectiveFrom
    || final.prospectivePricingCohort.effectiveBefore !== pin.pricingWindow.effectiveBefore
    || final.prospectivePricingCohort.digest !== pin.pricingWindow.digest
    || final.judgeCalibration.status !== pin.calibration.status
    || final.judgeCalibration.digest !== pin.calibration.digest
    || final.externalPackCustody.status !== pin.custody.status
    || final.externalPackCustody.packDigest !== pin.custody.digest;
  if (drifted) throw new FixedTraceEvidencePrerequisiteUnavailableError();
  throw new FixedTraceEvidencePrerequisiteUnavailableError();
}

export class FixedTraceEvidencePrerequisiteUnavailableError extends Error {
  constructor() {
    super(FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION);
    this.name = "FixedTraceEvidencePrerequisiteUnavailableError";
  }
}
