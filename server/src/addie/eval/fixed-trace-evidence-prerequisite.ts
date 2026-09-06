/**
 * B's refusal-only prerequisite. It reads only the dependency-free A manifest
 * and an independent literal pin; neither is an execution authority.
 */
import {
  FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
  type FixedTraceAPurePrerequisiteManifest,
} from "./fixed-trace-a-prerequisite-manifest.js";

export const FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION =
  "not_admitted_missing_validated_A_schedule_pricing_custody_calibration_and_C_sealed_authority" as const;

type FixedTraceSha256 = string;
type FixedTraceUtcTimestamp = string;

/**
 * Exhaustive future-C record shape. It is a required schema declaration, not
 * a B-issued contract or an admission to dispatch. C must validate, snapshot,
 * and authenticate every nested value behind its sealed one-use authority.
 */
export interface FixedTraceSealedEvidenceRequirements {
  readonly schemaVersion: "addie-fixed-trace-sealed-evidence-v1";
  readonly plan: {
    readonly protocolFingerprint: FixedTraceSha256;
    readonly corpusSuiteVersion: string;
    readonly corpusSuiteSha256: FixedTraceSha256;
    readonly partitionManifestSha256: FixedTraceSha256;
    readonly experimentalDesignFingerprint: FixedTraceSha256;
    readonly measurementManifestSha256: FixedTraceSha256;
    readonly packManifestSha256: FixedTraceSha256;
    readonly packCustodySignature: string;
  };
  readonly assignment: {
    readonly runId: string;
    readonly phaseId: string;
    readonly armId: string;
    readonly architectureId: string;
    readonly caseId: string;
    readonly episodeId: string;
    readonly clusterId: string;
    readonly stratumId: string;
    readonly repetition: number;
    readonly blockId: string;
    readonly order: number;
    readonly position: number;
    readonly randomizationSeed: string;
    readonly scheduleDigest: FixedTraceSha256;
    readonly workerIdentity: string;
  };
  readonly invocation: {
    readonly stage: "router" | "generation" | "judge" | "simulator";
    readonly invocation: number;
    readonly attempt: number;
    readonly requestedProvider: string;
    readonly requestedModel: string;
    readonly requestedEffort: string;
    readonly returnedProvider: string | null;
    readonly returnedModel: string | null;
    readonly returnedEffort: string | null;
    readonly identityPolicy: string;
    readonly fallbackOfAttempt: number | null;
  };
  readonly requestIntegrity: {
    readonly systemSha256: FixedTraceSha256;
    readonly promptSha256: FixedTraceSha256;
    readonly messagesSha256: FixedTraceSha256;
    readonly toolSchemaSha256: FixedTraceSha256;
    readonly providerRequestSha256: FixedTraceSha256;
    readonly presentedToolNamesSha256: FixedTraceSha256;
    readonly presentedToolOrderSha256: FixedTraceSha256;
    readonly requestFactsSha256: FixedTraceSha256;
    readonly sourceThreadBindingSha256: FixedTraceSha256;
  };
  readonly toolAndSimulatorEvidence: {
    readonly toolCallSha256: FixedTraceSha256 | null;
    readonly toolInputSha256: FixedTraceSha256 | null;
    readonly toolResultSha256: FixedTraceSha256 | null;
    readonly simulatorReceiptSha256: FixedTraceSha256 | null;
    readonly simulatorFaultProvenanceSha256: FixedTraceSha256 | null;
    readonly simulatorControlsSha256: FixedTraceSha256;
  };
  readonly configuration: {
    readonly architectureSha256: FixedTraceSha256;
    readonly admissionSha256: FixedTraceSha256;
    readonly configSha256: FixedTraceSha256;
    readonly promptConfigSha256: FixedTraceSha256;
    readonly softwareSha256: FixedTraceSha256;
    readonly adapterSha256: FixedTraceSha256;
    readonly limitsSha256: FixedTraceSha256;
    readonly retryPolicySha256: FixedTraceSha256;
    readonly cachePolicySha256: FixedTraceSha256;
    readonly samplingPolicySha256: FixedTraceSha256;
  };
  readonly timingAndOutcome: {
    readonly preparedAt: FixedTraceUtcTimestamp;
    readonly dispatchedAt: FixedTraceUtcTimestamp | null;
    readonly completedAt: FixedTraceUtcTimestamp | null;
    readonly latencyMs: number | null;
    readonly timeout: boolean;
    readonly errorCode: string | null;
    readonly terminalStatus: string;
    readonly outputSha256: FixedTraceSha256 | null;
  };
  readonly usageAndPricing: {
    readonly usageSha256: FixedTraceSha256 | null;
    readonly inputTokens: number | null;
    readonly cachedInputTokens: number | null;
    readonly outputTokens: number | null;
    readonly pricingCohortId: string;
    readonly pricingCohortSha256: FixedTraceSha256;
    readonly pricingEffectiveFrom: FixedTraceUtcTimestamp;
    readonly pricingEffectiveBefore: FixedTraceUtcTimestamp | null;
    readonly computedCostUsd: number | null;
    readonly reservationId: string;
    readonly reservationCeilingUsd: number;
    readonly settlementSha256: FixedTraceSha256 | null;
  };
  readonly denominatorAndSequence: {
    readonly denominatorId: string;
    readonly failureEvidenceSha256: FixedTraceSha256;
    readonly missingnessSha256: FixedTraceSha256;
    readonly expectedSequenceSha256: FixedTraceSha256;
    readonly actualSequenceSha256: FixedTraceSha256;
    readonly completeness: "complete" | "incomplete" | "unknown_exposure";
    readonly tamperClass: "none" | "omission" | "insertion" | "duplication" | "substitution" | "reordering";
  };
  readonly judgeAndCustody: {
    readonly calibrationDigest: FixedTraceSha256;
    readonly blindedPresentationSha256: FixedTraceSha256;
    readonly adjudicationBinding: FixedTraceSha256;
    readonly providerExposureLedgerSha256: FixedTraceSha256;
    readonly custodyBinding: FixedTraceSha256;
    readonly signerKeyId: string;
    readonly signature: string;
  };
  readonly replayProtection: {
    readonly authorityId: string;
    readonly nonce: string;
    readonly oneUseConsumptionSha256: FixedTraceSha256;
    readonly replayStatus: "consumed";
  };
}

/** A mapped object makes additions to the schema fail at this one shared list. */
export const FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS: Readonly<{
  [Key in keyof FixedTraceSealedEvidenceRequirements]: true;
}> = Object.freeze({
  schemaVersion: true,
  plan: true,
  assignment: true,
  invocation: true,
  requestIntegrity: true,
  toolAndSimulatorEvidence: true,
  configuration: true,
  timingAndOutcome: true,
  usageAndPricing: true,
  denominatorAndSequence: true,
  judgeAndCustody: true,
  replayProtection: true,
});

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

export type FixedTraceEvidencePrerequisiteDiagnostic =
  | Readonly<{
    status: "ordinary_unavailable";
    code: typeof FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION;
    reason: "A_manifest_is_pinned_but_required_artifacts_are_unavailable";
  }>
  | Readonly<{
    status: "pin_drift";
    code: "fixed_trace_A_prerequisite_pin_drift";
    mismatchedFields: readonly string[];
  }>;

function mismatchedFields(
  manifest: FixedTraceAPurePrerequisiteManifest,
): readonly string[] {
  const pin = FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN;
  return Object.freeze([
    ...(manifest.protocolFingerprint !== pin.protocolFingerprint ? ["protocolFingerprint"] : []),
    ...(manifest.corpus.suiteVersion !== pin.corpusSuiteVersion ? ["corpus.suiteVersion"] : []),
    ...(manifest.corpus.suiteSha256 !== pin.corpusSuiteSha256 ? ["corpus.suiteSha256"] : []),
    ...(manifest.partitionManifestSha256 !== pin.partitionManifestSha256 ? ["partitionManifestSha256"] : []),
    ...(manifest.experimentalDesignFingerprint !== pin.experimentalDesignFingerprint ? ["experimentalDesignFingerprint"] : []),
    ...(manifest.measurementManifestSha256 !== pin.measurementManifestSha256 ? ["measurementManifestSha256"] : []),
    ...(manifest.schedule.status !== pin.schedule.status || manifest.schedule.digest !== pin.schedule.digest ? ["schedule"] : []),
    ...(manifest.pricingWindow.status !== pin.pricingWindow.status
      || manifest.pricingWindow.cohortId !== pin.pricingWindow.cohortId
      || manifest.pricingWindow.effectiveFrom !== pin.pricingWindow.effectiveFrom
      || manifest.pricingWindow.effectiveBefore !== pin.pricingWindow.effectiveBefore
      || manifest.pricingWindow.digest !== pin.pricingWindow.digest ? ["pricingWindow"] : []),
    ...(manifest.calibration.status !== pin.calibration.status || manifest.calibration.digest !== pin.calibration.digest ? ["calibration"] : []),
    ...(manifest.providerExposure.status !== pin.providerExposure.status
      || manifest.providerExposure.digest !== pin.providerExposure.digest ? ["providerExposure"] : []),
    ...(manifest.custody.status !== pin.custody.status || manifest.custody.digest !== pin.custody.digest ? ["custody"] : []),
  ]);
}

/** No caller input: the B boundary always compares its literal pin to A's pure manifest. */
export function fixedTraceEvidencePrerequisiteDiagnostic(): FixedTraceEvidencePrerequisiteDiagnostic {
  const fields = mismatchedFields(FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST);
  if (fields.length > 0) return Object.freeze({
    status: "pin_drift",
    code: "fixed_trace_A_prerequisite_pin_drift",
    mismatchedFields: fields,
  });
  return Object.freeze({
    status: "ordinary_unavailable",
    code: FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION,
    reason: "A_manifest_is_pinned_but_required_artifacts_are_unavailable",
  });
}

export class FixedTraceEvidencePrerequisitePinDriftError extends Error {
  readonly status = "pin_drift" as const;
  readonly code = "fixed_trace_A_prerequisite_pin_drift" as const;
  readonly diagnostic: Extract<FixedTraceEvidencePrerequisiteDiagnostic, { status: "pin_drift" }>;

  constructor(diagnostic: Extract<FixedTraceEvidencePrerequisiteDiagnostic, { status: "pin_drift" }>) {
    super(diagnostic.code);
    this.name = "FixedTraceEvidencePrerequisitePinDriftError";
    this.diagnostic = diagnostic;
  }
}

/** Propagate pin drift; ordinary unavailable remains a safe non-dispatch result. */
export function assertFixedTraceEvidencePrerequisitePinned(): Extract<
  FixedTraceEvidencePrerequisiteDiagnostic,
  { status: "ordinary_unavailable" }
> {
  const diagnostic = fixedTraceEvidencePrerequisiteDiagnostic();
  if (diagnostic.status === "pin_drift") {
    throw new FixedTraceEvidencePrerequisitePinDriftError(diagnostic);
  }
  return diagnostic;
}
