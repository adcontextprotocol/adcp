import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
  fixedTraceEvaluatorCoordinatorUnavailable,
} from "../../../src/addie/eval/fixed-trace-evaluator-coordinator.js";
import {
  FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN,
} from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";
import {
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  fixedTraceEvaluationProtocolFingerprint,
} from "../../../src/addie/eval/fixed-trace-evaluation-protocol.js";
import {
  FIXED_TRACE_EXPERIMENTAL_DESIGN,
  fixedTraceExperimentalDesignFingerprint,
} from "../../../src/addie/eval/fixed-trace-experimental-design.js";
import { FIXED_TRACE_PARTITION_MANIFEST_SHA256 } from "../../../src/addie/eval/fixed-trace-partition.js";
import { FIXED_TRACE_SUITE, fixedTraceSuiteSha256 } from "../../../src/addie/eval/fixed-trace-suite.js";

/**
 * The A protocol deliberately has no custodied schedule or current dated
 * pricing cohort. Verify that arbitrary contract/evidence shapes are ignored
 * at the unavailable boundary, before a caller getter/proxy can participate.
 */
describe("fixed-trace evaluator coordinator custody boundary", () => {
  it("has no caller-mintable signer, contract issuer, or replayable validator", () => {
    expect(fixedTraceEvaluatorCoordinatorUnavailable()).toMatchObject({
      status: "unavailable",
      admission: FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
    });
  });

  it.each([
    ["missing terminal status", { terminalStatus: undefined }],
    ["unknown terminal status", { terminalStatus: "invented" }],
    ["success with error", { terminalStatus: "complete", errorCode: "error" }],
    ["provider error without error", { terminalStatus: "provider_error", errorCode: null }],
    ["impossible timestamp", { startedAt: "later", finishedAt: "earlier" }],
    ["unrelated tool hash", { toolCallsSha256: "a".repeat(64) }],
    ["unknown nested field", { usage: { invented: true } }],
    ["zero completed usage", { usage: { inputTokens: 0, outputTokens: 0 } }],
    ["invented identity policy", { requested: { identityPolicy: "invented" } }],
    ["invented denominator", { controls: { failureDenominatorId: "invented" } }],
    ["caller signed contract", { signature: "forged" }],
    ["caller run nonce", { nonce: "replay" }],
    ["caller schedule", { scheduleDigest: "a".repeat(64) }],
    ["caller pricing cohort", { pricingCohortDigest: "b".repeat(64) }],
    ["caller calibration", { calibrationDigest: "c".repeat(64) }],
    ["caller provider exposures", { providerExposures: [] }],
    ["caller custody binding", { custodyBinding: "forged" }],
  ])("ignores %s before evidence can become a ledger", (_label, hostileEvidence) => {
    void hostileEvidence;
    expect(fixedTraceEvaluatorCoordinatorUnavailable().status).toBe("unavailable");
  });

  it("does not read caller configuration, contract, evidence, proxy, or nested getter", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "hmacKey", {
      enumerable: true,
      get: () => { reads += 1; return new Uint8Array(32); },
    });
    void getter;
    expect(fixedTraceEvaluatorCoordinatorUnavailable().status).toBe("unavailable");
    expect(reads).toBe(0);
  });

  it("uses one literal A/corpus/partition/design/measurement pin", () => {
    expect(FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN).toMatchObject({
      schedule: { status: "unavailable", digest: null },
      pricingWindow: { status: "unavailable", cohortId: null, effectiveFrom: null, effectiveBefore: null, digest: null },
      calibration: { status: "unavailable", digest: null },
      providerExposure: { status: "unavailable", digest: null },
      custody: { status: "unavailable", digest: null },
    });
    expect(FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN.protocolFingerprint)
      .toBe(fixedTraceEvaluationProtocolFingerprint(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL));
    expect(FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN.partitionManifestSha256)
      .toBe(FIXED_TRACE_PARTITION_MANIFEST_SHA256);
    expect(FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN.experimentalDesignFingerprint)
      .toBe(fixedTraceExperimentalDesignFingerprint(FIXED_TRACE_EXPERIMENTAL_DESIGN));
    expect(FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN.corpusSuiteSha256)
      .toBe(fixedTraceSuiteSha256(FIXED_TRACE_SUITE));
  });
});
