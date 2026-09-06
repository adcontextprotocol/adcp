import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION,
  fixedTraceJudgeSummaryUnavailable,
  fixedTraceJudgeUnavailable,
} from "../../../src/addie/eval/fixed-trace-judge.js";
import {
  FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
} from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";

describe("fixed-trace judge refusal boundary", () => {
  it("exports only unavailable state and one exhaustive shared C schema manifest", () => {
    const result = fixedTraceJudgeUnavailable();
    expect(result).toMatchObject({
      status: "unavailable",
      admission: FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION,
      requiredSealedEvidence: FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
    });
    const leaves = (value: unknown, prefix = ""): string[] => {
      if (typeof value === "object" && value !== null && "type" in value) return [prefix];
      return Object.entries(value as Record<string, unknown>)
        .flatMap(([key, nested]) => leaves(nested, prefix ? `${prefix}.${key}` : key));
    };
    const isDeeplyFrozen = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null || !Object.isFrozen(value)) return false;
      if ("type" in value) {
        const values = (value as { values?: unknown }).values;
        return values === undefined || (Array.isArray(values) && Object.isFrozen(values));
      }
      return Object.values(value).every(isDeeplyFrozen);
    };
    expect(leaves(FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS)).toEqual(`
schemaVersion
plan.protocolFingerprint
plan.corpusSuiteVersion
plan.corpusSuiteSha256
plan.partitionManifestSha256
plan.experimentalDesignFingerprint
plan.measurementManifestSha256
plan.packManifestSha256
plan.packCustodySignature
assignment.runId
assignment.phaseId
assignment.armId
assignment.architectureId
assignment.caseId
assignment.episodeId
assignment.clusterId
assignment.stratumId
assignment.repetition
assignment.blockId
assignment.order
assignment.position
assignment.randomizationSeed
assignment.scheduleDigest
assignment.workerIdentity
invocation.stage
invocation.invocation
invocation.attempt
invocation.requestedProvider
invocation.requestedModel
invocation.requestedEffort
invocation.returnedProvider
invocation.returnedModel
invocation.returnedEffort
invocation.identityPolicy
invocation.fallbackOfAttempt
requestIntegrity.systemSha256
requestIntegrity.promptSha256
requestIntegrity.messagesSha256
requestIntegrity.toolSchemaSha256
requestIntegrity.providerRequestSha256
requestIntegrity.presentedToolNamesSha256
requestIntegrity.presentedToolOrderSha256
requestIntegrity.requestFactsSha256
requestIntegrity.sourceThreadBindingSha256
toolAndSimulatorEvidence.toolCallSha256
toolAndSimulatorEvidence.toolInputSha256
toolAndSimulatorEvidence.toolResultSha256
toolAndSimulatorEvidence.simulatorReceiptSha256
toolAndSimulatorEvidence.simulatorFaultProvenanceSha256
toolAndSimulatorEvidence.simulatorControlsSha256
configuration.architectureSha256
configuration.admissionSha256
configuration.configSha256
configuration.promptConfigSha256
configuration.softwareSha256
configuration.adapterSha256
configuration.limitsSha256
configuration.retryPolicySha256
configuration.cachePolicySha256
configuration.samplingPolicySha256
timingAndOutcome.preparedAt
timingAndOutcome.dispatchedAt
timingAndOutcome.completedAt
timingAndOutcome.latencyMs
timingAndOutcome.timeout
timingAndOutcome.errorCode
timingAndOutcome.terminalStatus
timingAndOutcome.finishReason
timingAndOutcome.outputSha256
usageAndPricing.usageSha256
usageAndPricing.inputTokens
usageAndPricing.cachedInputTokens
usageAndPricing.outputTokens
usageAndPricing.pricingCohortId
usageAndPricing.pricingCohortSha256
usageAndPricing.pricingEffectiveFrom
usageAndPricing.pricingEffectiveBefore
usageAndPricing.computedCostUsd
usageAndPricing.reservationId
usageAndPricing.reservationCeilingUsd
usageAndPricing.settlementSha256
denominatorAndSequence.denominatorId
denominatorAndSequence.failureEvidenceSha256
denominatorAndSequence.missingnessSha256
denominatorAndSequence.expectedSequenceSha256
denominatorAndSequence.actualSequenceSha256
denominatorAndSequence.completeness
denominatorAndSequence.tamperClass
judgeAndCustody.calibrationDigest
judgeAndCustody.blindedPresentationSha256
judgeAndCustody.adjudicationBinding
judgeAndCustody.providerExposureLedgerSha256
judgeAndCustody.custodyBinding
judgeAndCustody.signerKeyId
judgeAndCustody.signature
replayProtection.authorityId
replayProtection.nonce
replayProtection.oneUseConsumptionSha256
replayProtection.replayStatus`.trim().split("\n"));
    expect(isDeeplyFrozen(FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS)).toBe(true);
    expect(FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.assignment.runId).toEqual({ type: "string" });
    expect(FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.assignment.repetition).toEqual({ type: "number" });
    const closedDomains = [
      [FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.schemaVersion, ["addie-fixed-trace-sealed-evidence-v1"]],
      [FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.invocation.stage, ["router", "generation", "judge", "simulator"]],
      [FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.timingAndOutcome.terminalStatus, ["complete", "ignored", "reacted", "refusal", "truncated", "empty", "malformed", "provider_error", "timeout_after_dispatch", "unknown_exposure", "not_dispatched_budget", "not_admitted_architecture"]],
      [FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.timingAndOutcome.finishReason, ["stop", "tool_calls", "length", "refusal", "continue"]],
      [FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.denominatorAndSequence.completeness, ["complete", "incomplete", "unknown_exposure"]],
      [FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.denominatorAndSequence.tamperClass, ["none", "omission", "insertion", "duplication", "substitution", "reordering"]],
      [FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS.replayProtection.replayStatus, ["consumed"]],
    ] as const;
    for (const [descriptor, expectedValues] of closedDomains) {
      expect(descriptor.values).toEqual(expectedValues);
      expect(Object.isFrozen(descriptor.values)).toBe(true);
      expect(Reflect.deleteProperty(descriptor.values, 0)).toBe(false);
      expect(Reflect.set(descriptor.values, 0, "forged")).toBe(false);
      expect(Reflect.set(descriptor.values, descriptor.values.length, "forged")).toBe(false);
    }
  });

  it("has no positive dispatch/configuration entrypoint to consume hostile values", () => {
    const reads = { get: 0, primitive: 0 };
    const hostile = new Proxy({
      [Symbol.toPrimitive]: () => { reads.primitive += 1; throw new Error("coerced"); },
    }, { get: () => { reads.get += 1; throw new Error("read"); } });
    const entry = fixedTraceJudgeUnavailable as unknown as (...args: unknown[]) => unknown;
    const summaryEntry = fixedTraceJudgeSummaryUnavailable as unknown as (...args: unknown[]) => unknown;
    expect(entry(hostile)).toMatchObject({ status: "unavailable" });
    expect(summaryEntry(hostile)).toMatchObject({ status: "unavailable" });
    expect(reads).toEqual({ get: 0, primitive: 0 });
  });

  it("cannot be mistaken for complete observations or comparison eligibility", () => {
    expect(fixedTraceJudgeSummaryUnavailable()).toMatchObject({
      status: "unavailable",
      expectedCases: 0,
      observedJudgments: 0,
      expectedRecordCountObserved: false,
      comparisonEligible: false,
      totalEstimatedCostUsd: null,
    });
  });
});
